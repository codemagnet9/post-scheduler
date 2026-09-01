// test/token-vault.test.ts
// Encryption round-trips across a key rotation, and NO token string ever reaches the logs.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { withTenant } from '../src/db/tenant';
import { encrypt, decrypt, currentKeyId, _resetKeyringForTest } from '../src/vault/crypto';
import { storeTokens, loadTokens, reencryptTokens } from '../src/vault/tokens';
import { createWorkspace } from '../src/workspaces/service';
import { createFakeProvider } from '../src/providers/adapters/fake';
import { registerAdapter } from '../src/providers/registry';
import * as connect from '../src/accounts/connect';
import { adminDb, asRows } from './helpers/db';

async function createUser(email: string): Promise<string> {
  return asRows<{ id: string }>(await db.execute(sql`insert into users (email) values (${email}) returning id`))[0].id;
}

describe('vault crypto', () => {
  it('round-trips a value', () => {
    const { ciphertext, keyId } = encrypt('super-secret-token');
    expect(decrypt(ciphertext, keyId)).toBe('super-secret-token');
    expect(keyId).toBe(currentKeyId());
  });

  it('tampered ciphertext fails the auth tag', () => {
    const { ciphertext, keyId } = encrypt('x');
    ciphertext[ciphertext.length - 1] ^= 0xff;
    expect(() => decrypt(ciphertext, keyId)).toThrow();
  });
});

describe('key rotation', () => {
  afterEach(() => {
    process.env.MERIDIAN_KEY_CURRENT = 'v1';
    _resetKeyringForTest();
  });

  it('old ciphertext stays readable after rotating the current key, and reencrypt migrates it', async () => {
    const stamp = String(Date.now());
    const userId = await createUser(`vault-${stamp}@meridian.test`);
    const { workspaceId } = await createWorkspace(userId, 'Vault');
    const accountId = await withTenant({ workspaceId, userId, role: 'owner' }, async (tx) => {
      const acc = asRows<{ id: string }>(await tx.execute(sql`
        insert into connected_accounts (workspace_id, provider, provider_account_id, timezone)
        values (${workspaceId}, 'bluesky', ${'acct-' + stamp}, 'UTC') returning id`))[0];
      await storeTokens(tx, { connectedAccountId: acc.id, workspaceId, credentials: { accessToken: 'A-' + stamp, refreshToken: 'R-' + stamp } });
      return acc.id;
    });

    // Written under v1.
    expect(await withTenant({ workspaceId, userId, role: 'owner' }, (tx) => loadTokens(tx, accountId).then((t) => t?.keyId))).toBe('v1');

    // Rotate current key to v2 (no downtime, no data migration required to keep working).
    process.env.MERIDIAN_KEY_CURRENT = 'v2';
    _resetKeyringForTest();

    // Old row still decrypts via its stored key id.
    const before = await withTenant({ workspaceId, userId, role: 'owner' }, (tx) => loadTokens(tx, accountId));
    expect(before?.credentials.accessToken).toBe('A-' + stamp);
    expect(before?.keyId).toBe('v1');

    // Background re-encryption (maintenance connection, cross-tenant) moves it to v2.
    const migrated = await reencryptTokens(adminDb as unknown as { execute: (q: unknown) => Promise<unknown> });
    expect(migrated).toBeGreaterThanOrEqual(1);
    const after = await withTenant({ workspaceId, userId, role: 'owner' }, (tx) => loadTokens(tx, accountId));
    expect(after?.credentials.accessToken).toBe('A-' + stamp);
    expect(after?.keyId).toBe('v2');
  });
});

describe('no token ever reaches the logs', () => {
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  const captured: string[] = [];

  beforeAll(() => {
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      spies.push(vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { captured.push(args.map(String).join(' ')); }));
    }
  });
  afterEach(() => { captured.length = 0; });

  it('a full connect flow never prints the token', async () => {
    const stamp = String(Date.now());
    const SENTINEL = `SENTINEL-TOKEN-${stamp}`;
    const { adapter } = createFakeProvider({ key: `vault-connect-${stamp}` });
    registerAdapter(adapter);

    const userId = await createUser(`logs-${stamp}@meridian.test`);
    const { workspaceId } = await createWorkspace(userId, 'Logs');

    // Credential connect submits the sentinel as the token; the fake echoes it into credentials.
    await connect.completeCredentialConnect(
      { userId, role: 'owner', workspaceId },
      adapter.key,
      { token: SENTINEL },
    );

    expect(captured.join('\n')).not.toContain(SENTINEL);
  });
});
