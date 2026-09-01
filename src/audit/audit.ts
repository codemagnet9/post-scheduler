// src/audit/audit.ts
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/tenant';

export interface AuditEntry {
  workspaceId: string | null;      // null for account-level security events (login, reset)
  actorUserId: string | null;
  actorApiKeyId?: string | null;
  action: string;                  // 'membership.role_changed', 'auth.login_success', ...
  targetType?: string;
  targetId?: string | null;
  before?: unknown;                // captured pre-change state
  after?: unknown;                 // captured post-change state
  ip?: string | null;
  userAgent?: string | null;
  workspaceSlug?: string | null;   // denormalized so the trail is readable after workspace delete
}

// Append-only. Call inside the SAME tx as the change so the record commits atomically with it.
// audit_log RLS allows this insert either within a workspace context or, for null-workspace
// security events, when app.user_id is set (see db/migrations/0004).
export async function writeAudit(tx: Tx, e: AuditEntry): Promise<void> {
  const metadata = JSON.stringify({ before: e.before ?? null, after: e.after ?? null });
  await tx.execute(sql`
    insert into audit_log (workspace_id, workspace_slug, actor_user_id, actor_api_key_id,
                           action, target_type, target_id, ip, user_agent, metadata)
    values (${e.workspaceId}, ${e.workspaceSlug ?? null}, ${e.actorUserId}, ${e.actorApiKeyId ?? null},
            ${e.action}, ${e.targetType ?? null}, ${e.targetId ?? null},
            ${e.ip ?? null}, ${e.userAgent ?? null}, ${metadata}::jsonb)
  `);
}
