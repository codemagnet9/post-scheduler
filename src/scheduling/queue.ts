// src/scheduling/queue.ts
// Weekly recurring queue slots per workspace per market (an IANA zone). Adding a post takes the next
// open slot; removing one reflows everything behind it.
//
// WHEN A SLOT IS DELETED: the market is reflowed. Every queued post in that market is reassigned, in
// its existing queue order, onto the next available occurrences of the REMAINING active slots. If
// there are now fewer occurrences than posts (e.g. the last slot was removed), the posts that no
// longer fit revert to 'draft' — their targets go back to draft and an event is emitted — so a post
// is never silently stranded on a slot that no longer exists.
import { sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../db/tenant';
import { toTs } from '../db/index';
import { authorize, type Actor } from '../authz/abilities';
import { emitEvent } from '../events/emit';
import { resolveWallClockToUTC } from './time';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];
export type ScopedActor = Actor & { workspaceId: string };

function dateInZone(zone: string, ms: number): { y: number; mo: number; d: number } {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms))) p[part.type] = part.value;
  return { y: +p.year, mo: +p.month, d: +p.day };
}

// Generate slot occurrences (as UTC instants) for a market, strictly after `fromMs`, over a horizon.
async function generateOccurrences(tx: Tx, workspaceId: string, market: string, fromMs: number, count: number): Promise<Date[]> {
  const slots = rows<{ day_of_week: number; local_time: string }>(await tx.execute(sql`
    select day_of_week, local_time from queue_slots where workspace_id = ${workspaceId} and market_timezone = ${market} and active
  `));
  if (!slots.length) return [];
  const out: Date[] = [];
  const start = dateInZone(market, fromMs);
  for (let i = 0; i < 90 && out.length < count + 5; i += 1) {
    const dayMs = Date.UTC(start.y, start.mo - 1, start.d) + i * 86400_000;
    const cal = new Date(dayMs);
    const weekday = cal.getUTCDay();
    for (const s of slots.filter((sl) => sl.day_of_week === weekday)) {
      const [h, mi] = s.local_time.split(':').map(Number);
      const { instant } = resolveWallClockToUTC(market, cal.getUTCFullYear(), cal.getUTCMonth() + 1, cal.getUTCDate(), h, mi);
      if (instant.getTime() > fromMs) out.push(instant);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

export async function addSlot(actor: ScopedActor, market: string, dayOfWeek: number, localTime: string, label?: string) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'queue_slot:manage');
    const r = rows<{ id: string }>(await tx.execute(sql`
      insert into queue_slots (workspace_id, market_timezone, day_of_week, local_time, label) values (${actor.workspaceId}, ${market}, ${dayOfWeek}, ${localTime}, ${label ?? null})
      on conflict (workspace_id, market_timezone, day_of_week, local_time) do update set active = true returning id
    `));
    return { slotId: r[0].id };
  });
}

export async function moveSlot(actor: ScopedActor, slotId: string, dayOfWeek: number, localTime: string) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'queue_slot:manage');
    const r = rows<{ market_timezone: string }>(await tx.execute(sql`update queue_slots set day_of_week = ${dayOfWeek}, local_time = ${localTime}, updated_at = now() where id = ${slotId} returning market_timezone`));
    if (r.length) await reflowInTx(tx, actor.workspaceId, r[0].market_timezone);
  });
}

export async function removeSlot(actor: ScopedActor, slotId: string) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    authorize(actor, 'queue_slot:manage');
    const r = rows<{ market_timezone: string }>(await tx.execute(sql`delete from queue_slots where id = ${slotId} returning market_timezone`));
    if (r.length) await reflowInTx(tx, actor.workspaceId, r[0].market_timezone); // deleted-slot rule
  });
}

export async function computeNextOpenSlots(actor: ScopedActor, market: string, count: number): Promise<Date[]> {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, async (tx) => {
    const occ = await generateOccurrences(tx, actor.workspaceId, market, Date.now(), count + 20);
    const taken = new Set(rows<{ scheduled_at: Date }>(await tx.execute(sql`
      select scheduled_at from posts where workspace_id = ${actor.workspaceId} and schedule_type = 'queued' and queue_market_timezone = ${market} and status in ('scheduled','publishing') and scheduled_at is not null
    `)).map((p) => new Date(p.scheduled_at).getTime()));
    return occ.filter((o) => !taken.has(o.getTime())).slice(0, count);
  });
}

// Reflow the whole market: reassign queued posts in order onto fresh occurrences.
async function reflowInTx(tx: Tx, workspaceId: string, market: string): Promise<void> {
  const posts = rows<{ id: string }>(await tx.execute(sql`
    select id from posts where workspace_id = ${workspaceId} and schedule_type = 'queued' and queue_market_timezone = ${market} and status = 'scheduled'
    order by scheduled_at nulls last, created_at
  `));
  const occ = await generateOccurrences(tx, workspaceId, market, Date.now(), posts.length);
  for (let i = 0; i < posts.length; i += 1) {
    if (i < occ.length) {
      await tx.execute(sql`update posts set scheduled_at = ${toTs(occ[i])}, updated_at = now() where id = ${posts[i].id}`);
      await tx.execute(sql`update post_targets set scheduled_at = ${toTs(occ[i])}, publish_due_at = ${toTs(occ[i])}, version = version + 1 where post_id = ${posts[i].id} and state = 'scheduled'`);
    } else {
      // No slot left for this post — revert it to draft rather than strand it.
      await tx.execute(sql`update posts set status = 'draft', scheduled_at = null, updated_at = now() where id = ${posts[i].id}`);
      await tx.execute(sql`update post_targets set state = 'draft', scheduled_at = null, publish_due_at = null, version = version + 1 where post_id = ${posts[i].id} and state = 'scheduled'`);
      await emitEvent(tx, { workspaceId, aggregateType: 'post', aggregateId: posts[i].id, type: 'post.unqueued_no_slot' });
    }
  }
}

export async function reflowMarket(actor: ScopedActor, market: string) {
  return withTenant({ workspaceId: actor.workspaceId, userId: actor.userId, role: actor.role }, (tx) => reflowInTx(tx, actor.workspaceId, market));
}
