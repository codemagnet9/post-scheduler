// src/analytics/read-models.ts
// The dashboard read models. All are computed LIVE (no pre-aggregation table) — deliberately:
// snapshots per post are bounded (1h + 24h + 7d + ~12 weekly ≈ 15 rows/post forever), so the table
// grows linearly in posts, not in time, and the (workspace_id, captured_at) + (target, captured_at)
// indexes keep a DISTINCT-ON "latest snapshot per target" aggregation fast into the millions of rows.
// The documented scale path, when a single workspace passes ~10M snapshots, is a nightly
// metric_rollup_daily table fed from the same immutable snapshots; until then, live is simpler and
// always current.
//
// A post's CURRENT value is its LATEST snapshot (max captured_at). Aggregates SUM those latest values
// over the posts published in the period. Because unavailable fields are NULL, SQL sum() skips them:
// an all-unavailable metric sums to NULL (rendered "not available"), never a fake 0.
import { sql } from 'drizzle-orm';
import { withTenant, type TenantContext, type Tx } from '../db/tenant';
import { resolveAdapter, hasAdapter } from '../providers/registry';
import { engagementRate, ENGAGEMENT_RATE_SQL } from './normalize';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const iso = (d: Date): string => d.toISOString();

export interface DateRange { from: Date; to: Date }

export function metricsSupported(provider: string): boolean {
  return hasAdapter(provider) && resolveAdapter(provider).capabilities.supportsMetrics;
}

// --- 1) HEADLINE: four figures with period-over-period change. ---
export interface HeadlineFigure { value: number | null; previous: number | null; changePct: number | null }
export interface Headline {
  impressions: HeadlineFigure;
  engagements: HeadlineFigure;
  engagementRate: HeadlineFigure;
  linkClicks: HeadlineFigure;
}

interface PeriodSums { impressions: number | null; engagements: number | null; clicks: number | null }

// Latest snapshot per target (as of `to`) summed over targets published in [from, to). NULL sums =
// unavailable, never 0.
async function periodSums(tx: Tx, ws: string, from: Date, to: Date): Promise<PeriodSums> {
  const r = rows<{ impressions: string | null; engagements: string | null; clicks: string | null }>(await tx.execute(sql`
    with latest as (
      select distinct on (ms.post_target_id) ms.post_target_id, ms.impressions, ms.engagements, ms.clicks
      from metric_snapshots ms
      where ms.workspace_id = ${ws} and ms.captured_at <= ${iso(to)}
      order by ms.post_target_id, ms.captured_at desc
    )
    select sum(l.impressions) as impressions, sum(l.engagements) as engagements, sum(l.clicks) as clicks
    from post_targets pt
    join latest l on l.post_target_id = pt.id
    where pt.workspace_id = ${ws} and pt.state = 'published'
      and pt.published_at >= ${iso(from)} and pt.published_at < ${iso(to)}
  `))[0] ?? { impressions: null, engagements: null, clicks: null };
  return { impressions: num(r.impressions), engagements: num(r.engagements), clicks: num(r.clicks) };
}

function changePct(value: number | null, previous: number | null): number | null {
  if (value === null || previous === null || previous === 0) return null;
  return (value - previous) / previous;
}
const figure = (value: number | null, previous: number | null): HeadlineFigure => ({ value, previous, changePct: changePct(value, previous) });

export async function headline(ctx: TenantContext, { from, to }: DateRange): Promise<Headline> {
  const len = to.getTime() - from.getTime();
  const prevFrom = new Date(from.getTime() - len);
  return withTenant(ctx, async (tx) => {
    const cur = await periodSums(tx, ctx.workspaceId, from, to);
    const prev = await periodSums(tx, ctx.workspaceId, prevFrom, from);
    return {
      impressions: figure(cur.impressions, prev.impressions),
      engagements: figure(cur.engagements, prev.engagements),
      // engagement rate uses the ONE definition (engagements / impressions) on the period sums.
      engagementRate: figure(engagementRate(cur.engagements, cur.impressions), engagementRate(prev.engagements, prev.impressions)),
      linkClicks: figure(cur.clicks, prev.clicks),
    };
  });
}

// --- 2) DAILY SERIES BY NETWORK (multi-series line chart). ---
// Per (network, day), the day's last snapshot per target, summed. Impressions kept alongside so the
// chart can plot either measure. Days with no snapshot simply have no point (a gap, not a 0).
export interface DailyPoint { provider: string; day: string; engagements: number | null; impressions: number | null }

export async function dailySeriesByNetwork(ctx: TenantContext, { from, to }: DateRange): Promise<DailyPoint[]> {
  return withTenant(ctx, async (tx) => {
    const r = rows<{ provider: string; day: string; engagements: string | null; impressions: string | null }>(await tx.execute(sql`
      with daily as (
        select distinct on (ms.post_target_id, ms.captured_at::date)
          ca.provider, ms.captured_at::date as day, ms.post_target_id, ms.engagements, ms.impressions
        from metric_snapshots ms
        join connected_accounts ca on ca.id = ms.connected_account_id
        where ms.workspace_id = ${ctx.workspaceId} and ms.captured_at >= ${iso(from)} and ms.captured_at < ${iso(to)}
        order by ms.post_target_id, ms.captured_at::date, ms.captured_at desc
      )
      select provider, day, sum(engagements) as engagements, sum(impressions) as impressions
      from daily group by provider, day order by day, provider
    `));
    return r.map((x) => ({ provider: x.provider, day: String(x.day).slice(0, 10), engagements: num(x.engagements), impressions: num(x.impressions) }));
  });
}

// --- 3) POSTS PUBLISHED PER NETWORK. metricsSupported flags the "not available" networks. ---
export interface NetworkPostCount { provider: string; posts: number; metricsSupported: boolean }

export async function postsPerNetwork(ctx: TenantContext, { from, to }: DateRange): Promise<NetworkPostCount[]> {
  return withTenant(ctx, async (tx) => {
    const r = rows<{ provider: string; posts: string }>(await tx.execute(sql`
      select ca.provider, count(*)::int as posts
      from post_targets pt
      join connected_accounts ca on ca.id = pt.connected_account_id
      where pt.workspace_id = ${ctx.workspaceId} and pt.state = 'published'
        and pt.published_at >= ${iso(from)} and pt.published_at < ${iso(to)}
      group by ca.provider order by posts desc, ca.provider
    `));
    return r.map((x) => ({ provider: x.provider, posts: Number(x.posts), metricsSupported: metricsSupported(x.provider) }));
  });
}

// --- 4) TOP POSTS BY ENGAGEMENT RATE. Only posts with impressions can have a rate (else unavailable
//        -> excluded). Rate uses the single ENGAGEMENT_RATE_SQL definition. ---
export interface TopPost { postId: string; engagements: number | null; impressions: number | null; engagementRate: number | null }

export async function topPostsByEngagementRate(ctx: TenantContext, { from, to }: DateRange, limit = 10): Promise<TopPost[]> {
  return withTenant(ctx, async (tx) => {
    const r = rows<{ post_id: string; engagements: string | null; impressions: string | null; engagement_rate: string | null }>(await tx.execute(sql`
      with latest as (
        select distinct on (ms.post_target_id) ms.post_target_id, ms.engagements, ms.impressions
        from metric_snapshots ms
        where ms.workspace_id = ${ctx.workspaceId} and ms.captured_at <= ${iso(to)}
        order by ms.post_target_id, ms.captured_at desc
      )
      select p.id as post_id, sum(l.engagements) as engagements, sum(l.impressions) as impressions,
             ${sql.raw(ENGAGEMENT_RATE_SQL)} as engagement_rate
      from posts p
      join post_targets pt on pt.post_id = p.id
      join latest l on l.post_target_id = pt.id
      where p.workspace_id = ${ctx.workspaceId} and pt.state = 'published'
        and pt.published_at >= ${iso(from)} and pt.published_at < ${iso(to)}
      group by p.id
      having sum(l.impressions) > 0
      order by engagement_rate desc nulls last
      limit ${limit}
    `));
    return r.map((x) => ({ postId: x.post_id, engagements: num(x.engagements), impressions: num(x.impressions), engagementRate: num(x.engagement_rate) }));
  });
}

// --- 5) DAY-BY-HOUR ENGAGEMENT HEATMAP ("best time to post"). Buckets published posts by the local
//        (account-timezone) weekday+hour they went out, averaging their latest engagements. ---
export interface HeatCell { dow: number; hour: number; avgEngagements: number | null; posts: number }

export async function engagementHeatmap(ctx: TenantContext, { from, to }: DateRange): Promise<HeatCell[]> {
  return withTenant(ctx, async (tx) => {
    const r = rows<{ dow: number; hour: number; avg_engagements: string | null; posts: string }>(await tx.execute(sql`
      with latest as (
        select distinct on (ms.post_target_id) ms.post_target_id, ms.engagements
        from metric_snapshots ms
        where ms.workspace_id = ${ctx.workspaceId} and ms.captured_at <= ${iso(to)}
        order by ms.post_target_id, ms.captured_at desc
      )
      select extract(dow  from (pt.published_at at time zone ca.timezone))::int as dow,
             extract(hour from (pt.published_at at time zone ca.timezone))::int as hour,
             avg(l.engagements)::float8 as avg_engagements, count(*)::int as posts
      from post_targets pt
      join connected_accounts ca on ca.id = pt.connected_account_id
      join latest l on l.post_target_id = pt.id
      where pt.workspace_id = ${ctx.workspaceId} and pt.state = 'published'
        and pt.published_at >= ${iso(from)} and pt.published_at < ${iso(to)}
        and l.engagements is not null
      group by dow, hour order by dow, hour
    `));
    return r.map((x) => ({ dow: Number(x.dow), hour: Number(x.hour), avgEngagements: num(x.avg_engagements), posts: Number(x.posts) }));
  });
}
