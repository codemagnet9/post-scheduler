// src/db/tenant.ts
import { sql } from 'drizzle-orm';
import { db } from './index';

export interface TenantContext {
  workspaceId: string;
  userId: string | null;
  role: string;
}

// The transaction handle passed to units of work. Kept structural so callers don't import
// drizzle internals; every query in a unit of work must go through this `tx`, never bare `db`.
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// Sentinel actor for background jobs (no human). Not a real users row; audit rows use null actor.
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

// Tenant-scoped unit of work. Sets the RLS GUCs transaction-locally via set_config(...,true),
// so they are cleared on commit/rollback and CANNOT leak across pooled connections. Any query
// that skips this wrapper runs with no workspace set => RLS returns zero rows (fail closed).
export async function withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${ctx.workspaceId}, true)`);
    await tx.execute(sql`select set_config('app.user_id', ${ctx.userId ?? SYSTEM_USER_ID}, true)`);
    return fn(tx);
  });
}

// User-scoped unit of work (no workspace): auth, workspace bootstrap, invite accept, the switcher.
export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

// graphile-worker task wrapper: a job has no HTTP request, so its tenant context comes from the
// payload. Every tenant job MUST carry workspaceId; RLS applies to workers exactly as to requests.
export function tenantTask<P extends { workspaceId: string; userId?: string }>(
  handler: (payload: P, tx: Tx, helpers: unknown) => Promise<void>,
) {
  return async (payload: P, helpers: unknown) => {
    await withTenant(
      { workspaceId: payload.workspaceId, userId: payload.userId ?? SYSTEM_USER_ID, role: 'system' },
      (tx) => handler(payload, tx, helpers),
    );
  };
}
