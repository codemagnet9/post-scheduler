// src/scheduling/board.ts
// Read models + operations for the Calendar and Queue. Everything is PER-TARGET (never rolled up into
// one post status), because a post fans out to N accounts that each publish, fail and retry on their
// own. Reschedule resolves the new wall-clock server-side and re-checks it (a time that was fine at
// 09:30 may be in the past at 23:00, or the account may have expired) — the browser never commits a
// move the server hasn't confirmed.
import { sql } from 'drizzle-orm';
import { withTenant, type TenantContext } from '../db/tenant';
import { pgArray, toTs } from '../db/index';
import { authorize, type Actor } from '../authz/abilities';
import { emitEvent } from '../events/emit';
import { resolveWallClockToUTC } from './time';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];
export type ScopedActor = Actor & { workspaceId: string };
const ctxOf = (a: ScopedActor): TenantContext => ({ workspaceId: a.workspaceId, userId: a.userId, role: a.role });

export class RescheduleError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'RescheduleError'; }
}

// A calendar/queue event = one target, with the instant it publishes (or published) and the reason it
// failed, if any. The client renders `instant` in the viewing zone.
export interface BoardEvent {
  targetId: string; postId: string; provider: string; handle: string | null; displayName: string | null;
  timezone: string; state: string; scheduleType: string | null;
  instant: string | null; scheduledAt: string | null; publishedAt: string | null;
  failureCode: string | null; reason: string | null; text: string; authorId: string | null;
}

function mapEvent(r: Record<string, unknown>): BoardEvent {
  const err = r.last_error as { plainLanguage?: string } | null;
  return {
    targetId: String(r.target_id), postId: String(r.post_id), provider: String(r.provider),
    handle: (r.handle as string) ?? null, displayName: (r.display_name as string) ?? null,
    timezone: String(r.timezone), state: String(r.state), scheduleType: (r.schedule_type as string) ?? null,
    instant: r.evt ? new Date(r.evt as string).toISOString() : null,
    scheduledAt: r.scheduled_at ? new Date(r.scheduled_at as string).toISOString() : null,
    publishedAt: r.published_at ? new Date(r.published_at as string).toISOString() : null,
    failureCode: (r.failure_code as string) ?? null, reason: err?.plainLanguage ?? null,
    text: (r.text as string) ?? '', authorId: (r.author_id as string) ?? null,
  };
}

const SELECT = sql`
  pt.id as target_id, pt.post_id, ca.provider, ca.handle, ca.display_name, ca.timezone, ca.status as account_status,
  pt.state, pt.scheduled_at, pt.publish_due_at, pt.published_at, pt.failure_code, pt.last_error,
  p.author_id, p.content->>'text' as text, p.schedule_type,
  coalesce(pt.published_at, pt.publish_due_at, pt.scheduled_at, pt.created_at) as evt`;

// --- CALENDAR: every non-draft target whose instant lands in [from, to). ---
export async function listCalendar(actor: ScopedActor, range: { from: string; to: string }): Promise<BoardEvent[]> {
  return withTenant(ctxOf(actor), async (tx) => {
    authorize(actor, 'queue_slot:view');
    const r = rows(await tx.execute(sql`
      select ${SELECT}
      from post_targets pt
      join connected_accounts ca on ca.id = pt.connected_account_id
      join posts p on p.id = pt.post_id
      where pt.state <> 'draft'
        and coalesce(pt.published_at, pt.publish_due_at, pt.scheduled_at) >= ${range.from}
        and coalesce(pt.published_at, pt.publish_due_at, pt.scheduled_at) < ${range.to}
      order by evt`));
    return r.map(mapEvent);
  });
}

// --- QUEUE: cursor-paginated per-target rows, filtered by state group / network / author. ---
const STATE_GROUPS: Record<string, string[]> = {
  upcoming: ['scheduled', 'publishing', 'reconciling'],
  drafts: ['draft'],
  published: ['published'],
  failed: ['failed', 'needs_review'],
};
const encodeCursor = (instant: string, id: string): string => Buffer.from(`${instant}|${id}`).toString('base64url');
function decodeCursor(c?: string): { instant: string; id: string } | null {
  if (!c) return null;
  const [instant, id] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  return instant && id ? { instant, id } : null;
}

export async function listQueue(actor: ScopedActor, opts: { group?: string; provider?: string; authorId?: string; cursor?: string; limit?: number }): Promise<{ data: BoardEvent[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const states = STATE_GROUPS[opts.group ?? 'upcoming'] ?? STATE_GROUPS.upcoming;
  const desc = opts.group === 'published' || opts.group === 'failed'; // recent-first for history
  const cur = decodeCursor(opts.cursor);
  return withTenant(ctxOf(actor), async (tx) => {
    authorize(actor, 'queue_slot:view');
    const fetched = rows(await tx.execute(sql`
      with q as (
        select ${SELECT}
        from post_targets pt
        join connected_accounts ca on ca.id = pt.connected_account_id
        join posts p on p.id = pt.post_id
        where pt.state::text = any(${pgArray(states)}::text[])
          ${opts.provider ? sql`and ca.provider = ${opts.provider}` : sql``}
          ${opts.authorId ? sql`and p.author_id = ${opts.authorId}` : sql``}
      )
      select * from q
      ${cur ? (desc ? sql`where (evt, target_id) < (${cur.instant}, ${cur.id})` : sql`where (evt, target_id) > (${cur.instant}, ${cur.id})`) : sql``}
      order by evt ${desc ? sql`desc` : sql`asc`}, target_id ${desc ? sql`desc` : sql`asc`}
      limit ${limit + 1}`));
    const page = fetched.slice(0, limit).map(mapEvent);
    const nextCursor = fetched.length > limit && page.length ? encodeCursor(String(fetched[limit - 1].evt), page[page.length - 1].targetId) : null;
    return { data: page, nextCursor };
  });
}

// --- RESCHEDULE (bulk): resolve server-side, re-check EACH target, move what's valid — all in ONE
// transaction/ONE request, so a browser interruption mid-batch can never leave an unknown split
// between "moved" and "not attempted". A target refusing the new time (its account expired since
// selection, it's no longer 'scheduled', or the resolved instant is now in the past) is an EXPECTED
// business outcome, not a transaction failure: it does not roll back its siblings, and it is reported
// explicitly per target — never silently dropped, never misreported as having moved. Only a genuine
// server/DB error aborts the whole transaction, so nothing commits in that case ("all" succeeded
// requests are truly durable together, or a real failure leaves NONE of them applied).
export interface RescheduleResult { targetId: string; ok: boolean; instant?: string; code?: string; reason?: string }

export async function rescheduleTargets(actor: ScopedActor, targetIds: string[], when: { localDate: string; localTime: string; zone: string }): Promise<{ results: RescheduleResult[] }> {
  if (!targetIds.length) return { results: [] };
  return withTenant(ctxOf(actor), async (tx) => {
    authorize(actor, 'post:schedule');

    const [y, mo, d] = when.localDate.split('-').map(Number);
    const [h, mi] = when.localTime.split(':').map(Number);
    const instant = resolveWallClockToUTC(when.zone, y, mo, d, h, mi).instant;
    const inPast = instant.getTime() <= Date.now();

    const results: RescheduleResult[] = [];
    for (const targetId of targetIds) {
      // FOR UPDATE locks this row for the rest of THIS transaction — a concurrent mutation waits
      // rather than racing us, and every accepted move below commits together on transaction end.
      const t = rows<{ state: string; account_status: string }>(await tx.execute(sql`
        select pt.state, ca.status as account_status
        from post_targets pt join connected_accounts ca on ca.id = pt.connected_account_id
        where pt.id = ${targetId} for update of pt`))[0];

      if (!t) { results.push({ targetId, ok: false, code: 'not_found', reason: 'That post is no longer here.' }); continue; }
      if (t.state !== 'scheduled') { results.push({ targetId, ok: false, code: 'not_reschedulable', reason: 'Only a scheduled post can be moved.' }); continue; }
      if (inPast) { results.push({ targetId, ok: false, code: 'schedule_in_past', reason: 'That time has already passed — pick a time in the future.' }); continue; }
      if (t.account_status !== 'active') { results.push({ targetId, ok: false, code: 'account_reauth_required', reason: 'Reconnect this account before scheduling — its connection expired.' }); continue; }

      await tx.execute(sql`update post_targets set scheduled_at = ${toTs(instant)}, publish_due_at = ${toTs(instant)}, version = version + 1 where id = ${targetId} and state = 'scheduled'`);
      await emitEvent(tx, { workspaceId: actor.workspaceId, aggregateType: 'post_target', aggregateId: targetId, type: 'post_target.rescheduled', payload: { instant: instant.toISOString() } });
      results.push({ targetId, ok: true, instant: instant.toISOString() });
    }
    return { results };
  });
}

// Single-target convenience wrapper (Calendar drag-and-drop moves exactly one event at a time).
// Shares the exact same validation/locking path as the bulk version above; throws RescheduleError so
// existing single-target callers keep their reject-with-reason contract.
export async function rescheduleTarget(actor: ScopedActor, targetId: string, when: { localDate: string; localTime: string; zone: string }): Promise<{ targetId: string; instant: string }> {
  const { results } = await rescheduleTargets(actor, [targetId], when);
  const r = results[0];
  if (!r.ok) throw new RescheduleError(r.code ?? 'refused', r.reason ?? 'Could not move this post.');
  return { targetId: r.targetId, instant: r.instant as string };
}

// --- RETRY one failed target — independently of its siblings. ---
export async function retryTarget(actor: ScopedActor, targetId: string): Promise<{ ok: true }> {
  return withTenant(ctxOf(actor), async (tx) => {
    authorize(actor, 'post:schedule');
    const upd = rows(await tx.execute(sql`
      update post_targets set state = 'scheduled', publish_due_at = now(), failure_code = null, last_error = null, version = version + 1
      where id = ${targetId} and state in ('failed', 'needs_review') returning post_id`));
    if (!upd.length) throw new RescheduleError('not_retryable', 'Only a failed post can be retried.');
    await tx.execute(sql`update dead_letters set requeued_at = now(), requeued_by = ${actor.userId} where post_target_id = ${targetId} and requeued_at is null`);
    await emitEvent(tx, { workspaceId: actor.workspaceId, aggregateType: 'post_target', aggregateId: targetId, type: 'post_target.retry_requested' });
    return { ok: true };
  });
}

// --- CANCEL targets in bulk (scheduled/draft -> canceled). ---
export async function cancelTargets(actor: ScopedActor, targetIds: string[]): Promise<{ canceled: number }> {
  if (!targetIds.length) return { canceled: 0 };
  return withTenant(ctxOf(actor), async (tx) => {
    authorize(actor, 'post:schedule');
    const upd = rows<{ id: string }>(await tx.execute(sql`
      update post_targets set state = 'canceled', scheduled_at = null, publish_due_at = null, version = version + 1
      where id = any(${pgArray(targetIds)}::uuid[]) and state in ('scheduled', 'draft') returning id`));
    for (const r of upd) await emitEvent(tx, { workspaceId: actor.workspaceId, aggregateType: 'post_target', aggregateId: r.id, type: 'post_target.canceled' });
    return { canceled: upd.length };
  });
}

// --- SLOTS: current weekly slots, grouped by market on the client. ---
export async function listSlots(actor: ScopedActor): Promise<Row[]> {
  return withTenant(ctxOf(actor), (tx) => {
    authorize(actor, 'queue_slot:view');
    return tx.execute(sql`select id, market_timezone, label, day_of_week, local_time from queue_slots where active order by market_timezone, day_of_week, local_time`);
  }).then(rows);
}

// --- QUEUE HEALTH: runway, empty slots this week, per-market thinness (real read models). ---
export interface QueueHealth {
  runwayDays: number;
  slotsPerWeek: number;
  filledThisWeek: number;
  emptyThisWeek: number;
  markets: { market: string; slots: number; queued: number; thin: boolean }[];
}
export async function queueHealth(actor: ScopedActor): Promise<QueueHealth> {
  return withTenant(ctxOf(actor), async (tx) => {
    authorize(actor, 'queue_slot:view');
    const runway = rows<{ days: number | null }>(await tx.execute(sql`
      select ceil(extract(epoch from (max(publish_due_at) - now())) / 86400)::int as days
      from post_targets where state = 'scheduled'`))[0];
    const slots = rows<{ c: number }>(await tx.execute(sql`select count(*)::int as c from queue_slots where active`))[0];
    const filled = rows<{ c: number }>(await tx.execute(sql`select count(*)::int as c from post_targets where state = 'scheduled' and publish_due_at between now() and now() + interval '7 days'`))[0];
    const markets = rows<{ market: string; slots: number; queued: number }>(await tx.execute(sql`
      select qs.market_timezone as market, count(distinct qs.id)::int as slots,
             (select count(*)::int from posts p where p.schedule_type = 'queued' and p.queue_market_timezone = qs.market_timezone and p.status in ('scheduled', 'publishing')) as queued
      from queue_slots qs where qs.active group by qs.market_timezone order by qs.market_timezone`));
    const slotsPerWeek = Number(slots?.c ?? 0);
    const filledThisWeek = Number(filled?.c ?? 0);
    return {
      runwayDays: Math.max(0, Number(runway?.days ?? 0)),
      slotsPerWeek, filledThisWeek,
      emptyThisWeek: Math.max(0, slotsPerWeek - filledThisWeek),
      markets: markets.map((m) => ({ market: m.market, slots: Number(m.slots), queued: Number(m.queued), thin: Number(m.queued) < Number(m.slots) })),
    };
  });
}
