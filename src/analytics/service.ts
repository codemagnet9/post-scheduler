// src/analytics/service.ts
// The request-facing analytics API: authorize (analytics:view is granted to every role), parse the
// date range, and delegate to the read models / export. All heavy lifting is background or indexed.
import { authorize, type Actor } from '../authz/abilities';
import { SYSTEM_USER_ID, type TenantContext } from '../db/tenant';
import {
  headline, dailySeriesByNetwork, postsPerNetwork, topPostsByEngagementRate, engagementHeatmap,
  type DateRange,
} from './read-models';
import { createExport, getExport } from './export';
import { backfillWorkspaceMetrics } from './ingest';

const DAY = 86_400_000;

// Parse ?from&to (YYYY-MM-DD). Default: the last 30 days ending now. `to` is treated as exclusive
// end-of-day so a single-day range includes that whole day.
export function parseRange(q: { from?: string; to?: string }): DateRange {
  const to = q.to ? new Date(`${q.to}T00:00:00.000Z`) : new Date();
  const toExclusive = q.to ? new Date(to.getTime() + DAY) : to;
  const from = q.from ? new Date(`${q.from}T00:00:00.000Z`) : new Date(toExclusive.getTime() - 30 * DAY);
  return { from, to: toExclusive };
}

const actor = (ctx: TenantContext): Actor => ({ userId: ctx.userId ?? SYSTEM_USER_ID, role: ctx.role as Actor['role'] });

export async function dashboard(ctx: TenantContext, range: DateRange): Promise<unknown> {
  authorize(actor(ctx), 'analytics:view');
  const [head, series, perNetwork, top, heatmap] = await Promise.all([
    headline(ctx, range),
    dailySeriesByNetwork(ctx, range),
    postsPerNetwork(ctx, range),
    topPostsByEngagementRate(ctx, range),
    engagementHeatmap(ctx, range),
  ]);
  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    headline: head,
    dailySeriesByNetwork: series,
    postsPerNetwork: perNetwork,
    topPosts: top,
    engagementHeatmap: heatmap,
  };
}

export async function requestExport(ctx: TenantContext, range: DateRange): Promise<{ id: string; status: string }> {
  authorize(actor(ctx), 'analytics:view');
  return createExport(ctx, range);
}

export async function exportStatus(ctx: TenantContext, id: string): Promise<unknown> {
  authorize(actor(ctx), 'analytics:view');
  return getExport(ctx, id);
}

// On-demand backfill is an owner action (it's a workspace-wide operation).
export async function backfill(ctx: TenantContext): Promise<{ marked: number }> {
  authorize(actor(ctx), 'workspace:update');
  return { marked: await backfillWorkspaceMetrics(ctx) };
}
