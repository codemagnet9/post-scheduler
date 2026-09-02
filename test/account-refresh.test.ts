// test/account-refresh.test.ts
// Under concurrency an expiring token triggers exactly ONE refresh; a permanently-failing refresh
// moves the account to reauthorization-required and notifies exactly once.
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index';
import { withTenant } from '../src/db/tenant';
import { createWorkspace } from '../src/workspaces/service';
import { createFakeProvider } from '../src/providers/adapters/fake';
import { registerAdapter } from '../src/providers/registry';
import { storeTokens } from '../src/vault/tokens';
import { ensureFreshToken } from '../src/accounts/refresh';
import { NormalizedError } from '../src/providers/errors';
import { asRows } from './helpers/db';

async function createUser(email: string): Promise<string> {
  return asRows<{ id: string }>(await db.execute(sql`insert into users (email) values (${email}) returning id`))[0].id;
}

async function seedAccountWithExpiringToken(provider: string): Promise<{ workspaceId: string; userId: string; accountId: string }> {
  const stamp = String(Date.now()) + Math.trunc(performance.now());
  const userId = await createUser(`refresh-${stamp}@meridian.test`);
  const { workspaceId } = await createWorkspace(userId, 'Refresh');
  const accountId = await withTenant({ workspaceId, userId, role: 'owner' }, async (tx) => {
    const acc = asRows<{ id: string }>(await tx.execute(sql`
      insert into connected_accounts (workspace_id, provider, provider_account_id, timezone, status)
      values (${workspaceId}, ${provider}, ${'acct-' + stamp}, 'UTC', 'active') returning id`))[0];
    // Access token expires in 60s -> inside the 5-minute floor -> needsRefresh() is true.
    await storeTokens(tx, {
      connectedAccountId: acc.id, workspaceId,
      credentials: { accessToken: 'A', refreshToken: 'R', accessExpiresAt: new Date(Date.now() + 60_000) },
    });
    return acc.id;
  });
  return { workspaceId, userId, accountId };
}

describe('single-flight refresh', () => {
  it('ten concurrent callers trigger exactly one refresh', async () => {
    let refreshCalls = 0;
    const provider = `fake-refresh-${Date.now()}`;
    const { adapter } = createFakeProvider({
      key: provider,
      refresh: async (c) => {
        refreshCalls += 1;
        return { ...c, accessToken: 'A2', accessExpiresAt: new Date(Date.now() + 3600_000) };
      },
    });
    registerAdapter(adapter);
    const { workspaceId, userId, accountId } = await seedAccountWithExpiringToken(provider);

    const ctx = { workspaceId, userId, role: 'owner' as const };
    const results = await Promise.all(Array.from({ length: 10 }, () => ensureFreshToken(ctx, provider, accountId)));

    expect(refreshCalls).toBe(1);
    for (const creds of results) expect(creds.accessToken).toBe('A2'); // everyone got the fresh token
  });
});

describe('permanent refresh failure', () => {
  it('moves the account to auth_expired and notifies exactly once', async () => {
    const provider = `fake-reauth-${Date.now()}`;
    const { adapter } = createFakeProvider({
      key: provider,
      refresh: async () => { throw new NormalizedError('auth_expired', 'expired', 'token expired'); },
    });
    registerAdapter(adapter);
    const { workspaceId, userId, accountId } = await seedAccountWithExpiringToken(provider);
    const ctx = { workspaceId, userId, role: 'owner' as const };

    await expect(ensureFreshToken(ctx, provider, accountId)).rejects.toBeInstanceOf(NormalizedError);
    await expect(ensureFreshToken(ctx, provider, accountId)).rejects.toBeInstanceOf(NormalizedError); // second attempt

    await withTenant(ctx, async (tx) => {
      const status = asRows<{ status: string }>(await tx.execute(sql`select status from connected_accounts where id = ${accountId}`))[0].status;
      expect(status).toBe('auth_expired');
      const events = asRows(await tx.execute(sql`
        select id from events where aggregate_id = ${accountId} and type = 'connected_account.auth_expired'`));
      expect(events).toHaveLength(1); // notified once, not twice
    });
  });

  it('an UNKNOWN/ambiguous error is auth_expired (never revoked) and leaves queued targets scheduled', async () => {
    const provider = `fake-unknown-${Date.now()}`;
    const { adapter } = createFakeProvider({
      key: provider,
      // providerRaw even mentions 'invalid_grant' — the old string heuristic would have said
      // 'revoked'. With the fix, without the explicit revoked flag this must be auth_expired.
      refresh: async () => { throw new NormalizedError('provider_unavailable', 'weird', 'error: invalid_grant-ish text'); },
    });
    registerAdapter(adapter);
    const { workspaceId, userId, accountId } = await seedAccountWithExpiringToken(provider);
    const ctx = { workspaceId, userId, role: 'owner' as const };

    // A queued target on this account, as if a post were scheduled to it.
    const targetId = await withTenant(ctx, async (tx) => {
      const post = asRows<{ id: string }>(await tx.execute(sql`insert into posts (workspace_id, author_id) values (${workspaceId}, ${userId}) returning id`))[0];
      return asRows<{ id: string }>(await tx.execute(sql`
        insert into post_targets (post_id, workspace_id, connected_account_id, state, scheduled_at, publish_due_at)
        values (${post.id}, ${workspaceId}, ${accountId}, 'scheduled', now() + interval '1 hour', now() + interval '1 hour')
        returning id`))[0].id;
    });

    await expect(ensureFreshToken(ctx, provider, accountId)).rejects.toBeInstanceOf(NormalizedError);

    await withTenant(ctx, async (tx) => {
      const status = asRows<{ status: string }>(await tx.execute(sql`select status from connected_accounts where id = ${accountId}`))[0].status;
      expect(status).toBe('auth_expired'); // NOT revoked
      const target = asRows<{ state: string }>(await tx.execute(sql`select state from post_targets where id = ${targetId}`))[0];
      expect(target.state).toBe('scheduled'); // queue survives — auth_expired never skips
    });
  });
});
