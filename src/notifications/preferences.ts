// src/notifications/preferences.ts
// The preferences matrix: per user, per event, per channel. An absent row falls back to a coded
// default. This backs the settings screen and gates delivery in the dispatcher.
import { sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../db/tenant';
import { authorize, type Actor } from '../authz/abilities';

export type Channel = 'in_app' | 'email' | 'slack';
export const CHANNELS: Channel[] = ['in_app', 'email', 'slack'];

export type NotificationEvent =
  | 'publish_failed' | 'account_reconnect' | 'needs_approval' | 'post_approved'
  | 'post_changes_requested' | 'queue_low' | 'weekly_summary' | 'mention';

export const EVENTS: NotificationEvent[] = [
  'publish_failed', 'account_reconnect', 'needs_approval', 'post_approved',
  'post_changes_requested', 'queue_low', 'weekly_summary', 'mention',
];

// Sensible defaults. Slack is off unless the user opts in (and the workspace has a webhook).
const DEFAULTS: Record<NotificationEvent, Record<Channel, boolean>> = {
  publish_failed:         { in_app: true, email: true, slack: false },
  account_reconnect:      { in_app: true, email: true, slack: false },
  needs_approval:         { in_app: true, email: true, slack: false },
  post_approved:          { in_app: true, email: true, slack: false },
  post_changes_requested: { in_app: true, email: true, slack: false },
  queue_low:              { in_app: true, email: false, slack: false },
  weekly_summary:         { in_app: true, email: true, slack: false },
  mention:                { in_app: true, email: true, slack: false },
};

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];
export type ScopedActor = Actor & { workspaceId: string };

// Channels enabled for a user+event, applying overrides over defaults.
export async function enabledChannels(tx: Tx, userId: string, event: NotificationEvent): Promise<Channel[]> {
  const overrides = rows<{ channel: Channel; enabled: boolean }>(await tx.execute(sql`
    select channel, enabled from notification_preferences where user_id = ${userId} and event_type = ${event}
  `));
  const map = new Map(overrides.map((o) => [o.channel, o.enabled]));
  return CHANNELS.filter((ch) => map.get(ch) ?? DEFAULTS[event]?.[ch] ?? false);
}

export async function setPreference(actor: ScopedActor, event: NotificationEvent, channel: Channel, enabled: boolean) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    // No special ability — any member manages their OWN preferences (RLS enforces own-only writes).
    await tx.execute(sql`
      insert into notification_preferences (workspace_id, user_id, event_type, channel, enabled)
      values (${actor.workspaceId}, ${actor.userId}, ${event}, ${channel}, ${enabled})
      on conflict (workspace_id, user_id, event_type, channel) do update set enabled = excluded.enabled
    `);
    return { ok: true };
  });
}

// The full effective matrix for the settings screen (defaults merged with overrides).
export async function getPreferencesMatrix(actor: ScopedActor) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'workspace:view');
    const overrides = rows<{ event_type: NotificationEvent; channel: Channel; enabled: boolean }>(await tx.execute(sql`
      select event_type, channel, enabled from notification_preferences where user_id = ${actor.userId}
    `));
    const ov = new Map(overrides.map((o) => [`${o.event_type}:${o.channel}`, o.enabled]));
    return EVENTS.map((event) => ({
      event,
      channels: Object.fromEntries(CHANNELS.map((ch) => [ch, ov.get(`${event}:${ch}`) ?? DEFAULTS[event][ch]])),
    }));
  });
}
