// src/accounts/health.ts
// Account health state and the notify-once rule. Stored statuses live in the account_status enum;
// 'expiring_soon' and 'reauth_required' are DISPLAY states derived for the UI.
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/tenant';
import { emitEvent } from '../events/emit';

export type StoredStatus = 'active' | 'auth_expired' | 'revoked' | 'suspended' | 'disconnected';
export type UnhealthyStatus = 'auth_expired' | 'revoked' | 'suspended';
export type DisplayStatus = 'active' | 'expiring_soon' | 'reauth_required' | 'revoked' | 'suspended' | 'disconnected';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

const REFRESH_EXPIRY_WARN_DAYS = 3;

// What the UI shows per account. active + refresh token near its own expiry => a soft "expiring
// soon" warning; auth_expired => "reauthorization required".
export function computeDisplayStatus(
  stored: StoredStatus,
  // Accept a string too: drizzle's execute() returns timestamptz as a STRING, and a caller may pass
  // refresh_expires_at straight from a DB read. Coerce so the Date math can't throw.
  refreshExpiresAt: Date | string | null,
  now: Date = new Date(),
): DisplayStatus {
  if (stored === 'auth_expired') return 'reauth_required';
  if (stored !== 'active') return stored;
  const refreshExp = refreshExpiresAt ? new Date(refreshExpiresAt) : null;
  if (refreshExp && refreshExp.getTime() - now.getTime() < REFRESH_EXPIRY_WARN_DAYS * 86400_000) {
    return 'expiring_soon';
  }
  return 'active';
}

// Move an account into a bad status and notify the workspace ONCE per status (not repeatedly).
// The emitted event is the notify-once record (real delivery is Phase 8); health_notified_status
// dedupes so a flapping refresh doesn't spam the customer.
export async function setAccountUnhealthy(
  tx: Tx,
  params: { workspaceId: string; accountId: string; status: UnhealthyStatus; reason: string },
): Promise<{ notified: boolean }> {
  const prev = rows<{ health_notified_status: string | null }>(await tx.execute(sql`
    update connected_accounts set status = ${params.status}, updated_at = now()
    where id = ${params.accountId}
    returning health_notified_status
  `));
  const already = prev[0]?.health_notified_status;
  if (already === params.status) return { notified: false };

  await tx.execute(sql`
    update connected_accounts set health_notified_status = ${params.status}, health_notified_at = now()
    where id = ${params.accountId}
  `);
  await emitEvent(tx, {
    workspaceId: params.workspaceId,
    aggregateType: 'connected_account',
    aggregateId: params.accountId,
    type: `connected_account.${params.status}`,
    payload: { reason: params.reason },
  });
  return { notified: true };
}

// Reconnecting clears the bad status and the notify latch so a future failure notifies again.
export async function setAccountActive(tx: Tx, accountId: string): Promise<void> {
  await tx.execute(sql`
    update connected_accounts
    set status = 'active', health_notified_status = null, health_notified_at = null, updated_at = now()
    where id = ${accountId}
  `);
}
