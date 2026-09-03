// src/notifications/inbox.ts
// The in-app notification list and read state. RLS scopes both to the caller's own rows.
import { sql } from 'drizzle-orm';
import { withTenant } from '../db/tenant';
import type { Actor } from '../authz/abilities';

export type ScopedActor = Actor & { workspaceId: string };
const ctxOf = (a: ScopedActor) => ({ workspaceId: a.workspaceId, userId: a.userId, role: a.role });

export async function listNotifications(actor: ScopedActor) {
  return withTenant(ctxOf(actor), async (tx) =>
    tx.execute(sql`
      select id, event_type, title, body, deep_link, read_at, created_at
      from notifications
      where user_id = ${actor.userId} and 'in_app' = any(channels)
      order by created_at desc limit 100
    `),
  );
}

export async function markNotificationRead(actor: ScopedActor, id: string) {
  return withTenant(ctxOf(actor), async (tx) => {
    await tx.execute(sql`update notifications set read_at = now() where id = ${id} and user_id = ${actor.userId} and read_at is null`);
    return { ok: true };
  });
}
