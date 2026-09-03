// src/notifications/dispatcher.ts
// Consume the event outbox (emitted in Phases 4/6/8 — no new emission points) and turn events into
// notifications, delivered per-user per-channel per preferences. DELIVERY DISCIPLINE:
//   - dedupe: every notification carries a dedupe_key; a UNIQUE index collapses repeat signals to
//     ONE alert (ten failures against one account => one reconnection alert).
//   - deep link: every notification carries a link to the thing it's about.
//   - failures deliver immediately (this tick), the weekly summary is a separate cron (summary.ts).
import { sql } from 'drizzle-orm';
import { withTenant, SYSTEM_USER_ID, type Tx } from '../db/tenant';
import { pgArray } from '../db/index';
import { enabledChannels, type NotificationEvent } from './preferences';
import { getEmailProvider } from './email';
import { sendSlack } from './slack';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];
interface Recipient { id: string; email: string | null }

export interface MaintenanceDb {
  // `any` avoids the parameter-contravariance mismatch with drizzle's execute signature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts a drizzle sql query
  execute: (q: any) => Promise<any>;
}

export async function dispatchNotificationsTick(maint: MaintenanceDb, opts: { batch?: number } = {}): Promise<number> {
  const events = rows<{ id: string; workspace_id: string; aggregate_type: string; aggregate_id: string; type: string; payload: Record<string, unknown> }>(
    await maint.execute(sql`
      select id, workspace_id, aggregate_type, aggregate_id, type, payload
      from events where notified_at is null order by occurred_at limit ${opts.batch ?? 200}
    `),
  );
  for (const e of events) {
    try {
      await routeEvent(e);
    } catch (err) {
      if (process.env.DEBUG_DISPATCH) console.error('routeEvent failed', e.type, err);
      /* never let one bad event stall the outbox */
    }
    await maint.execute(sql`update events set notified_at = now() where id = ${e.id}`);
  }
  return events.length;
}

async function routeEvent(e: { workspace_id: string; aggregate_id: string; type: string; payload: Record<string, unknown> }): Promise<void> {
  await withTenant({ workspaceId: e.workspace_id, userId: SYSTEM_USER_ID, role: 'system' }, async (tx) => {
    const slack = (rows<{ slack_webhook_url: string | null }>(await tx.execute(sql`select slack_webhook_url from workspaces where id = ${e.workspace_id}`))[0] ?? {}).slack_webhook_url ?? null;
    const link = (path: string) => `/w/${e.workspace_id}/${path}`;

    if (['connected_account.auth_expired', 'connected_account.revoked', 'connected_account.suspended'].includes(e.type)) {
      for (const u of await membersByRole(tx, ['owner', 'approver'])) {
        await deliver(tx, e.workspace_id, u, slack, { event: 'account_reconnect', title: 'A connected account needs reconnecting', body: 'Reconnect it so scheduled posts keep going out.', deepLink: link('settings/accounts'), dedupeKey: `reconnect:${e.workspace_id}:${e.aggregate_id}:${u.id}` });
      }
      return;
    }
    if (e.type === 'post_target.failed') {
      const info = rows<{ post_id: string; author_id: string | null }>(await tx.execute(sql`select pt.post_id, p.author_id from post_targets pt join posts p on p.id = pt.post_id where pt.id = ${e.aggregate_id}`))[0];
      if (!info) return;
      const recips = await usersById(tx, uniq([info.author_id, ...(await roleIds(tx, ['owner']))]));
      for (const u of recips) {
        await deliver(tx, e.workspace_id, u, slack, { event: 'publish_failed', title: 'A post failed to publish', body: String(e.payload?.message ?? 'Open it to see why and retry.'), deepLink: link(`posts/${info.post_id}`), dedupeKey: `pubfail:${e.aggregate_id}:${u.id}` });
      }
      return;
    }
    if (e.type === 'post.submitted') {
      const author = (rows<{ author_id: string | null }>(await tx.execute(sql`select author_id from posts where id = ${e.aggregate_id}`))[0] ?? {}).author_id;
      const recips = (await membersByRole(tx, ['owner', 'approver'])).filter((u) => u.id !== author);
      for (const u of recips) {
        await deliver(tx, e.workspace_id, u, slack, { event: 'needs_approval', title: 'A post needs your approval', body: 'Review it before it goes out.', deepLink: link(`posts/${e.aggregate_id}`), dedupeKey: `approval:${e.aggregate_id}:${u.id}` });
      }
      return;
    }
    if (e.type === 'post.approved' || e.type === 'post.changes_requested') {
      const authorId = (e.payload?.authorId as string) ?? (rows<{ author_id: string | null }>(await tx.execute(sql`select author_id from posts where id = ${e.aggregate_id}`))[0] ?? {}).author_id;
      if (!authorId) return;
      const u = (await usersById(tx, [authorId]))[0];
      if (!u) return;
      const approved = e.type === 'post.approved';
      await deliver(tx, e.workspace_id, u, slack, {
        event: approved ? 'post_approved' : 'post_changes_requested',
        title: approved ? 'Your post was approved and scheduled' : 'Your post was sent back for changes',
        body: (e.payload?.note as string) ?? undefined,
        deepLink: link(`posts/${e.aggregate_id}`),
        dedupeKey: `${e.type}:${e.aggregate_id}:${u.id}`,
      });
      return;
    }
    if (e.type === 'comment.mentioned') {
      const mentioned = (e.payload?.mentions as string[]) ?? [];
      for (const u of await usersById(tx, mentioned)) {
        await deliver(tx, e.workspace_id, u, slack, { event: 'mention', title: 'You were mentioned in a comment', body: (e.payload?.excerpt as string) ?? undefined, deepLink: link(`posts/${e.aggregate_id}`), dedupeKey: `mention:${e.aggregate_id}:${u.id}` });
      }
      return;
    }
    if (e.type === 'queue.low') {
      const market = e.payload?.market as string | undefined;
      for (const u of await membersByRole(tx, ['owner', 'approver'])) {
        await deliver(tx, e.workspace_id, u, slack, { event: 'queue_low', title: 'Your queue is running low', body: market ? `${market} is almost out of scheduled slots.` : 'Add more content to keep publishing.', deepLink: link('queue'), dedupeKey: `queuelow:${e.workspace_id}:${market ?? ''}:${u.id}` });
      }
      return;
    }
    if (e.type === 'weekly_summary') {
      for (const u of await membersByRole(tx, ['owner', 'approver', 'editor', 'analyst'])) {
        await deliver(tx, e.workspace_id, u, slack, { event: 'weekly_summary', title: 'Your weekly summary', body: (e.payload?.summary as string) ?? undefined, deepLink: link('home'), dedupeKey: `weekly:${e.workspace_id}:${e.payload?.week ?? ''}:${u.id}` });
      }
    }
  });
}

interface DeliverInput { event: NotificationEvent; title: string; body?: string; deepLink: string; dedupeKey: string }
async function deliver(tx: Tx, workspaceId: string, user: Recipient, slack: string | null, n: DeliverInput): Promise<void> {
  const channels = await enabledChannels(tx, user.id, n.event);
  if (!channels.length) return;
  // The notifications row is BOTH the in-app item and the dedupe anchor: on conflict, we've already
  // alerted this user for this thing, so no channel fires again.
  const inserted = rows(await tx.execute(sql`
    insert into notifications (workspace_id, user_id, event_type, title, body, deep_link, channels, dedupe_key)
    values (${workspaceId}, ${user.id}, ${n.event}, ${n.title}, ${n.body ?? null}, ${n.deepLink}, ${pgArray(channels)}::text[], ${n.dedupeKey})
    on conflict (dedupe_key) where dedupe_key is not null do nothing returning id
  `));
  if (!inserted.length) return;
  if (channels.includes('email') && user.email) await getEmailProvider().send({ to: user.email, subject: n.title, text: `${n.body ?? n.title}\n\n${n.deepLink}` }).catch(() => undefined);
  if (channels.includes('slack') && slack) await sendSlack(slack, `${n.title} — ${n.deepLink}`);
}

async function membersByRole(tx: Tx, roles: string[]): Promise<Recipient[]> {
  // Workspace scoping is via RLS (memberships policy: workspace_id = app.workspace_id under the
  // system context). drizzle spreads the array into `in ($1,$2,...)`.
  return rows<Recipient>(await tx.execute(sql`
    select u.id, u.email from memberships m join users u on u.id = m.user_id
    where m.role::text in ${roles}
  `));
}
async function roleIds(tx: Tx, roles: string[]): Promise<string[]> {
  return (await membersByRole(tx, roles)).map((r) => r.id);
}
async function usersById(tx: Tx, ids: (string | null)[]): Promise<Recipient[]> {
  const clean = ids.filter((x): x is string => Boolean(x));
  if (!clean.length) return [];
  return rows<Recipient>(await tx.execute(sql`select id, email from users where id = any(${pgArray(clean)}::uuid[])`));
}
const uniq = (xs: (string | null)[]): (string | null)[] => [...new Set(xs)];
