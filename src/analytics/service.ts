// src/analytics/service.ts
// The request-facing analytics API: authorize (analytics:view is granted to every role), parse the
// date range, and delegate to the read models / export. All heavy lifting is background or indexed.
import { authorize, type Actor } from '../authz/abilities';
import { SYSTEM_USER_ID, type TenantContext } from '../db/tenant';
import { resolveWallClockToUTC } from '../scheduling/time';
import {
  headline, dailySeriesByNetwork, postsPerNetwork, topPostsByEngagementRate, engagementHeatmap,
  type DateRange,
} from './read-models';
import { createExport, getExport } from './export';
import { backfillWorkspaceMetrics } from './ingest';
import { metricsGlossary, type ProviderGlossaryEntry } from './glossary';

const DAY = 86_400_000;

// Midnight of a 'YYYY-MM-DD' date IN THE GIVEN ZONE, via the same DST-correct resolver the publisher
// and scheduler use — never a naive UTC-string parse. "The last 30 days" starting Monday means
// Monday 00:00 in the WORKSPACE's own zone, not wherever the browser happens to be.
function zonedMidnight(dateStr: string, tz: string): Date {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return resolveWallClockToUTC(tz, y, mo, d, 0, 0).instant;
}

// Parse ?from&to (YYYY-MM-DD) as midnight in `tz` (default UTC — preserves the documented /v1 public
// API contract for callers that don't pass a zone). `to` is treated as exclusive end-of-day so a
// single-day range includes that whole day.
export function parseRange(q: { from?: string; to?: string; tz?: string }): DateRange {
  const tz = q.tz || 'UTC';
  const to = q.to ? zonedMidnight(q.to, tz) : new Date();
  const toExclusive = q.to ? new Date(to.getTime() + DAY) : to;
  const from = q.from ? zonedMidnight(q.from, tz) : new Date(toExclusive.getTime() - 30 * DAY);
  return { from, to: toExclusive };
}

const actor = (ctx: TenantContext): Actor => ({ userId: ctx.userId ?? SYSTEM_USER_ID, role: ctx.role as Actor['role'] });

// `timezone` is the SAME zone the console labels "Showing …" and used to resolve `range` above — it
// drives the heatmap's day/hour buckets too, so every figure on the dashboard agrees with one clock.
export async function dashboard(ctx: TenantContext, range: DateRange, timezone = 'UTC'): Promise<unknown> {
  authorize(actor(ctx), 'analytics:view');
  const [head, series, perNetwork, top, heatmap] = await Promise.all([
    headline(ctx, range),
    dailySeriesByNetwork(ctx, range),
    postsPerNetwork(ctx, range),
    topPostsByEngagementRate(ctx, range),
    engagementHeatmap(ctx, range, timezone),
  ]);
  return {
    range: { from: range.from.toISOString(), to: range.to.toISOString() },
    timezone,
    headline: head,
    dailySeriesByNetwork: series,
    postsPerNetwork: perNetwork,
    topPosts: top,
    engagementHeatmap: heatmap,
  };
}

// The "How metrics are counted" reference: per REGISTERED adapter, which normalized fields it
// actually supports and what each maps to. Read-only, workspace-independent (same registry for every
// tenant) — exposed under the tenant-scoped route purely for URL/auth consistency with the rest of
// analytics, not because it carries tenant data.
export function glossary(ctx: TenantContext): ProviderGlossaryEntry[] {
  authorize(actor(ctx), 'analytics:view');
  return metricsGlossary();
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
