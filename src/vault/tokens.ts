// src/vault/tokens.ts
// The token vault. Encrypts/decrypts access + refresh tokens with the versioned keyring. Plaintext
// tokens exist only in memory between load and use — never in a column, log, response, or audit row.
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/tenant';
import type { Credentials } from '../providers/types';
import { encrypt, decrypt, currentKeyId } from './crypto';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

export interface LoadedTokens {
  credentials: Credentials;
  accessExpiresAt: Date | null;
  issuedAt: Date;   // updated_at, used as the issuance point for the refresh-ahead fraction
  keyId: string;
}

export async function storeTokens(
  tx: Tx,
  params: { connectedAccountId: string; workspaceId: string; credentials: Credentials },
): Promise<void> {
  const c = params.credentials;
  const access = encrypt(c.accessToken);
  const refresh = c.refreshToken ? encrypt(c.refreshToken) : null;
  await tx.execute(sql`
    insert into oauth_tokens (
      connected_account_id, workspace_id, access_token_ciphertext, refresh_token_ciphertext,
      key_id, scopes, access_expires_at, refresh_expires_at
    ) values (
      ${params.connectedAccountId}, ${params.workspaceId}, ${access.ciphertext}, ${refresh?.ciphertext ?? null},
      ${access.keyId}, ${c.scopes ?? []}, ${c.accessExpiresAt ?? null}, ${c.refreshExpiresAt ?? null}
    )
    on conflict (connected_account_id) do update set
      access_token_ciphertext  = excluded.access_token_ciphertext,
      refresh_token_ciphertext = excluded.refresh_token_ciphertext,
      key_id = excluded.key_id, scopes = excluded.scopes,
      access_expires_at = excluded.access_expires_at, refresh_expires_at = excluded.refresh_expires_at,
      updated_at = now(), rotated_at = now()
  `);
}

export async function loadTokens(tx: Tx, connectedAccountId: string): Promise<LoadedTokens | null> {
  const r = rows<{
    access_token_ciphertext: Buffer; refresh_token_ciphertext: Buffer | null; key_id: string;
    scopes: string[]; access_expires_at: Date | null; refresh_expires_at: Date | null; updated_at: Date;
  }>(await tx.execute(sql`
    select access_token_ciphertext, refresh_token_ciphertext, key_id, scopes,
           access_expires_at, refresh_expires_at, updated_at
    from oauth_tokens where connected_account_id = ${connectedAccountId}
  `));
  if (!r.length) return null;
  const t = r[0];
  const accessToken = decrypt(Buffer.from(t.access_token_ciphertext), t.key_id);
  const refreshToken = t.refresh_token_ciphertext ? decrypt(Buffer.from(t.refresh_token_ciphertext), t.key_id) : undefined;
  return {
    credentials: {
      accessToken,
      refreshToken,
      scopes: t.scopes,
      accessExpiresAt: t.access_expires_at ?? undefined,
      refreshExpiresAt: t.refresh_expires_at ?? undefined,
    },
    accessExpiresAt: t.access_expires_at,
    issuedAt: t.updated_at,
    keyId: t.key_id,
  };
}

// Online key rotation. Runs on a MAINTENANCE connection (cross-tenant read) — it re-encrypts every
// row still under an old key id with the current key. Safe to run repeatedly; idempotent once done.
export async function reencryptTokens(maintenanceDb: { execute: (q: unknown) => Promise<unknown> }): Promise<number> {
  const stale = rows<{ id: string; access_token_ciphertext: Buffer; refresh_token_ciphertext: Buffer | null; key_id: string }>(
    await maintenanceDb.execute(sql`
      select id, access_token_ciphertext, refresh_token_ciphertext, key_id
      from oauth_tokens where key_id <> ${currentKeyId()}
    `),
  );
  let n = 0;
  for (const t of stale) {
    const access = encrypt(decrypt(Buffer.from(t.access_token_ciphertext), t.key_id));
    const refresh = t.refresh_token_ciphertext ? encrypt(decrypt(Buffer.from(t.refresh_token_ciphertext), t.key_id)) : null;
    await maintenanceDb.execute(sql`
      update oauth_tokens set access_token_ciphertext = ${access.ciphertext},
        refresh_token_ciphertext = ${refresh?.ciphertext ?? null}, key_id = ${access.keyId}
      where id = ${t.id}
    `);
    n += 1;
  }
  return n;
}
