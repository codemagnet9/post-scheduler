// src/analytics/export.ts
// CSV export as a BACKGROUND JOB. The request only enqueues a row and returns immediately; a worker
// (process-exports cron) builds the file, stores it, and flips status to 'ready'. The API then hands
// back a short-lived signed URL — a large range never blocks or times out a request.
//
// One row per post-per-network, carrying each latest-snapshot metric. Unavailable fields are EMPTY
// cells, never 0. engagement_rate uses the single definition (engagementRate()).
import { sql } from 'drizzle-orm';
import { withTenant, type TenantContext } from '../db/tenant';
import { getStorage } from '../media/storage';
import { engagementRate, METRIC_FIELDS } from './normalize';
import type { MaintenanceDb } from './ingest';
import type { DateRange } from './read-models';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];
const iso = (d: Date): string => d.toISOString();
const day = (d: Date): string => d.toISOString().slice(0, 10);

export interface ExportRow { id: string; status: string }

// Request path: create the job (RLS-scoped) and return its id. The worker does the heavy lifting.
export async function createExport(ctx: TenantContext, { from, to }: DateRange): Promise<ExportRow> {
  return withTenant(ctx, async (tx) => {
    const r = rows<{ id: string; status: string }>(await tx.execute(sql`
      insert into analytics_exports (workspace_id, requested_by, date_from, date_to, status)
      values (${ctx.workspaceId}, ${ctx.userId}, ${day(from)}, ${day(to)}, 'pending')
      returning id, status
    `))[0];
    return r;
  });
}

// Request path: status + a fresh signed download URL when ready (never persisted — signed URLs rotate).
export async function getExport(ctx: TenantContext, id: string): Promise<{ id: string; status: string; rowCount: number | null; downloadUrl: string | null; error: string | null } | null> {
  return withTenant(ctx, async (tx) => {
    const r = rows<{ id: string; status: string; storage_key: string | null; row_count: number | null; error: string | null }>(await tx.execute(sql`
      select id, status, storage_key, row_count, error from analytics_exports where id = ${id}
    `))[0];
    if (!r) return null;
    const downloadUrl = r.status === 'ready' && r.storage_key ? await getStorage().signedGetUrl(r.storage_key, 3600) : null;
    return { id: r.id, status: r.status, rowCount: r.row_count, downloadUrl, error: r.error };
  });
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return ''; // unavailable metric => EMPTY, not 0
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const HEADERS = ['post_id', 'network', 'published_at', 'permalink', ...METRIC_FIELDS, 'engagement_rate', 'captured_at'];

// Build the CSV bytes for one export's date range (workspace filtered explicitly; safe on the
// RLS-bypassing maintenance connection).
async function buildCsv(maint: MaintenanceDb, ws: string, from: Date, to: Date): Promise<{ csv: string; rowCount: number }> {
  const data = rows<Record<string, unknown>>(await maint.execute(sql`
    with latest as (
      select distinct on (ms.post_target_id) ms.post_target_id, ms.impressions, ms.reach, ms.engagements,
             ms.clicks, ms.saves, ms.shares, ms.captured_at
      from metric_snapshots ms where ms.workspace_id = ${ws} and ms.captured_at <= ${iso(to)}
      order by ms.post_target_id, ms.captured_at desc
    )
    select pt.post_id, ca.provider, pt.published_at, pt.provider_permalink,
           l.impressions, l.reach, l.engagements, l.clicks, l.saves, l.shares, l.captured_at
    from post_targets pt
    join connected_accounts ca on ca.id = pt.connected_account_id
    left join latest l on l.post_target_id = pt.id
    where pt.workspace_id = ${ws} and pt.state = 'published'
      and pt.published_at >= ${iso(from)} and pt.published_at < ${iso(to)}
    order by pt.published_at, ca.provider
  `));

  const lines = [HEADERS.join(',')];
  for (const d of data) {
    const impressions = d.impressions === null || d.impressions === undefined ? null : Number(d.impressions);
    const engagements = d.engagements === null || d.engagements === undefined ? null : Number(d.engagements);
    const er = engagementRate(engagements, impressions); // same definition, everywhere
    lines.push([
      csvCell(d.post_id), csvCell(d.provider), csvCell(d.published_at ? iso(new Date(d.published_at as string)) : null), csvCell(d.provider_permalink),
      csvCell(d.impressions), csvCell(d.reach), csvCell(d.engagements), csvCell(d.clicks), csvCell(d.saves), csvCell(d.shares),
      csvCell(er), csvCell(d.captured_at ? iso(new Date(d.captured_at as string)) : null),
    ].join(','));
  }
  return { csv: lines.join('\n') + '\n', rowCount: data.length };
}

// Background worker tick: claim pending exports, build + store each, mark ready (or failed). Wired to
// the process-exports cron. Returns the number processed.
export async function processExportsTick(maint: MaintenanceDb, opts: { batch?: number } = {}): Promise<number> {
  const pending = rows<{ id: string; workspace_id: string; date_from: string; date_to: string }>(await maint.execute(sql`
    select id, workspace_id, date_from, date_to from analytics_exports
    where status = 'pending' order by created_at limit ${opts.batch ?? 10}
  `));

  let done = 0;
  for (const e of pending) {
    // Claim so a second worker can't process the same export.
    const claimed = rows(await maint.execute(sql`update analytics_exports set status = 'processing' where id = ${e.id} and status = 'pending' returning id`));
    if (!claimed.length) continue;
    try {
      // date columns arrive as 'YYYY-MM-DD'; to_date is inclusive, so add a day to make [from, to).
      const from = new Date(`${String(e.date_from).slice(0, 10)}T00:00:00.000Z`);
      const to = new Date(new Date(`${String(e.date_to).slice(0, 10)}T00:00:00.000Z`).getTime() + 86_400_000);
      const { csv, rowCount } = await buildCsv(maint, e.workspace_id, from, to);
      const key = `exports/${e.workspace_id}/${e.id}.csv`;
      await getStorage().putObject(key, Buffer.from(csv, 'utf8'), 'text/csv');
      await maint.execute(sql`update analytics_exports set status = 'ready', storage_key = ${key}, row_count = ${rowCount}, completed_at = now() where id = ${e.id}`);
      done += 1;
    } catch (err) {
      await maint.execute(sql`update analytics_exports set status = 'failed', error = ${String((err as Error).message ?? err).slice(0, 500)}, completed_at = now() where id = ${e.id}`);
    }
  }
  return done;
}
