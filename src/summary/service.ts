// src/summary/service.ts
// ONE endpoint for the shell's live counts (queue / approvals / networks + a few the dashboard uses),
// so the rail makes a single request instead of one per badge. Tenant-scoped: RLS restricts every
// count to the caller's workspace, and being a resolved member is the only authorization needed.
import { sql } from 'drizzle-orm';
import { withTenant, type TenantContext } from '../db/tenant';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];
const n = (v: unknown): number => Number(v ?? 0);

export interface WorkspaceSummary {
  queue: number;          // scheduled posts awaiting publish
  approvals: number;      // posts pending approval (open requests)
  networks: number;       // active connected accounts
  drafts: number;
  failed: number;         // targets that failed to publish
  needsReconnect: number; // accounts whose auth expired
}

export async function getSummary(ctx: TenantContext): Promise<WorkspaceSummary> {
  const r = rows<Record<string, string>>(await withTenant(ctx, (tx) => tx.execute(sql`
    select
      (select count(*) from posts where status = 'scheduled')                       as queue,
      (select count(*) from approval_requests where status = 'pending')             as approvals,
      (select count(*) from connected_accounts where status = 'active')             as networks,
      (select count(*) from posts where status in ('draft','changes_requested'))    as drafts,
      (select count(*) from post_targets where state = 'failed')                    as failed,
      (select count(*) from connected_accounts where status = 'auth_expired')       as needs_reconnect
  `)))[0];
  return {
    queue: n(r.queue), approvals: n(r.approvals), networks: n(r.networks),
    drafts: n(r.drafts), failed: n(r.failed), needsReconnect: n(r.needs_reconnect),
  };
}
