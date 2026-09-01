// src/accounts/refresh.ts
// Refresh ahead of expiry, single-flight per account.
//
// Refresh window: refresh when the access token has less than max(20% of its lifetime, 5 minutes)
// remaining. Why 20% + a 5-minute floor: 20% leaves comfortable margin for clock skew and the
// round-trip while a publish is queued, without refreshing so eagerly that we churn refresh tokens
// on providers that rotate them on every use; the 5-minute floor covers very short-lived tokens
// where 20% would be only seconds.
//
// Single-flight: many providers INVALIDATE the old refresh token when it is used, so ten concurrent
// publish jobs racing to refresh would log the customer out. A per-account Postgres advisory lock
// (pg_advisory_xact_lock) serializes them; a double-check after acquiring means only the first
// actually refreshes and the rest reuse the fresh token.
import { sql } from 'drizzle-orm';
import { withTenant, SYSTEM_USER_ID, type TenantContext } from '../db/tenant';
import { resolveAdapter } from '../providers/registry';
import { loadTokens, storeTokens } from '../vault/tokens';
import { setAccountUnhealthy, type UnhealthyStatus } from './health';
import { NormalizedError } from '../providers/errors';
import type { Credentials } from '../providers/types';

const REFRESH_FRACTION = 0.2;
const REFRESH_FLOOR_MS = 5 * 60 * 1000;

export function needsRefresh(accessExpiresAt: Date | null, issuedAt: Date, now: Date): boolean {
  if (!accessExpiresAt) return false; // no expiry known (e.g. long-lived channel token) => never
  const lifetime = Math.max(accessExpiresAt.getTime() - issuedAt.getTime(), 0);
  const remaining = accessExpiresAt.getTime() - now.getTime();
  const threshold = Math.max(lifetime * REFRESH_FRACTION, REFRESH_FLOOR_MS);
  return remaining <= threshold;
}

function classifyRefreshFailure(e: unknown): UnhealthyStatus {
  if (e instanceof NormalizedError && /revoke|invalid_grant/i.test(String(e.providerRaw))) return 'revoked';
  return 'auth_expired';
}

// Returns fresh, usable credentials for the account. Called by publish jobs and by the proactive
// worker. Under concurrency, triggers exactly one refresh.
export async function ensureFreshToken(ctx: TenantContext, provider: string, accountId: string): Promise<Credentials> {
  const now = new Date();
  const loaded = await withTenant(ctx, (tx) => loadTokens(tx, accountId));
  if (!loaded) throw new Error(`no tokens for account ${accountId}`);
  if (!needsRefresh(loaded.accessExpiresAt, loaded.issuedAt, now)) return loaded.credentials;

  // The refresh runs inside the advisory-locked tx. A failure must NOT roll back the health update,
  // so we return the outcome instead of throwing, then record health in a SEPARATE committed tx.
  const outcome = await withTenant(ctx, async (tx): Promise<
    | { kind: 'creds'; credentials: Credentials }
    | { kind: 'failed'; status: UnhealthyStatus; error: unknown }
  > => {
    // Serialize concurrent refreshers for THIS account. Released when this short tx commits.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${accountId}, 42))`);
    const cur = await loadTokens(tx, accountId);
    if (!cur) throw new Error(`no tokens for account ${accountId}`);
    if (!needsRefresh(cur.accessExpiresAt, cur.issuedAt, new Date())) return { kind: 'creds', credentials: cur.credentials }; // another flight won

    const adapter = resolveAdapter(provider);
    try {
      const fresh = await adapter.refreshCredentials(cur.credentials); // provider may return a NEW refresh token
      await storeTokens(tx, { connectedAccountId: accountId, workspaceId: ctx.workspaceId, credentials: fresh });
      return { kind: 'creds', credentials: fresh };
    } catch (e) {
      return { kind: 'failed', status: classifyRefreshFailure(e), error: e };
    }
  });

  if (outcome.kind === 'creds') return outcome.credentials;
  await withTenant(ctx, (tx) => setAccountUnhealthy(tx, { workspaceId: ctx.workspaceId, accountId, status: outcome.status, reason: 'refresh_failed' }));
  throw outcome.error;
}

// Proactive worker tick. Uses a MAINTENANCE connection to find due accounts across all tenants,
// then refreshes each in its own tenant context. Wired to graphile-worker cron in Phase 6.
export async function refreshWorkerTick(maintenanceDb: { execute: (q: unknown) => Promise<unknown> }): Promise<void> {
  const due = (await maintenanceDb.execute(sql`
    select ca.id as account_id, ca.workspace_id, ca.provider
    from oauth_tokens t
    join connected_accounts ca on ca.id = t.connected_account_id
    where ca.status = 'active'
      and t.access_expires_at is not null
      and t.access_expires_at <= now() + interval '15 minutes'
  `)) as unknown as Array<{ account_id: string; workspace_id: string; provider: string }>;

  for (const r of due) {
    await ensureFreshToken(
      { workspaceId: r.workspace_id, userId: SYSTEM_USER_ID, role: 'system' },
      r.provider,
      r.account_id,
    ).catch(() => { /* failures already moved the account to a bad status + notified once */ });
  }
}
