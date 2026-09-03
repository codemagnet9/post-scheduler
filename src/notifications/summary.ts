// src/notifications/summary.ts
// Cron-driven emitters (NOT real-time). The weekly summary and the queue-low check emit events that
// the dispatcher then turns into notifications. Wired to the worker crontab (per the standing rule:
// a background function without a cron entry is unfinished).
import { sql } from 'drizzle-orm';
import { withTenant, SYSTEM_USER_ID } from '../db/tenant';
import { emitEvent } from '../events/emit';
import type { MaintenanceDb } from './dispatcher';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];
const QUEUE_LOW_THRESHOLD = 3;

// One weekly_summary event per active workspace with a short stats line.
export async function weeklySummaryTick(maint: MaintenanceDb, weekLabel: string): Promise<number> {
  const wss = rows<{ id: string }>(await maint.execute(sql`select id from workspaces where deleted_at is null`));
  for (const w of wss) {
    await withTenant({ workspaceId: w.id, userId: SYSTEM_USER_ID, role: 'system' }, async (tx) => {
      const s = rows<{ published: number; failed: number; scheduled: number }>(await tx.execute(sql`
        select
          count(*) filter (where state = 'published' and published_at > now() - interval '7 days')::int as published,
          count(*) filter (where state = 'failed')::int as failed,
          count(*) filter (where state = 'scheduled')::int as scheduled
        from post_targets
      `))[0];
      const summary = `This week: ${s.published} published, ${s.scheduled} scheduled, ${s.failed} failed.`;
      await emitEvent(tx, { workspaceId: w.id, aggregateType: 'workspace', aggregateId: w.id, type: 'weekly_summary', payload: { week: weekLabel, summary } });
    });
  }
  return wss.length;
}

// Emit queue.low for any (workspace, market) that has active slots but few upcoming queued posts.
// `dayLabel` buckets the dedupe so it can re-alert on later days without spamming within a day.
export async function queueLowTick(maint: MaintenanceDb, dayLabel: string): Promise<number> {
  const markets = rows<{ workspace_id: string; market_timezone: string }>(await maint.execute(sql`
    select distinct workspace_id, market_timezone from queue_slots where active
  `));
  let emitted = 0;
  for (const m of markets) {
    await withTenant({ workspaceId: m.workspace_id, userId: SYSTEM_USER_ID, role: 'system' }, async (tx) => {
      const upcoming = Number(rows<{ c: number }>(await tx.execute(sql`
        select count(*)::int as c from posts
        where schedule_type = 'queued' and queue_market_timezone = ${m.market_timezone}
          and status = 'scheduled' and scheduled_at > now()
      `))[0].c);
      if (upcoming < QUEUE_LOW_THRESHOLD) {
        await emitEvent(tx, { workspaceId: m.workspace_id, aggregateType: 'workspace', aggregateId: m.workspace_id, type: 'queue.low', payload: { market: m.market_timezone, day: dayLabel, upcoming } });
        emitted += 1;
      }
    });
  }
  return emitted;
}
