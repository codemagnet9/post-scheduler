// src/analytics/ingest.ts
// METRIC INGESTION. Pull each published target's metrics on a decaying schedule and store an
// IMMUTABLE snapshot every time — we never overwrite; a snapshot is a photograph of the numbers at
// captured_at, and the timeline is the sequence of photographs.
//
// SCHEDULE (relative to publish): +1h, +24h, +7d, then weekly to ~90 days, then we stop. The cursor
// lives on post_targets.metrics_next_at, set to +1h at publish (metrics-capable networks only).
//
// PROTECTION — analytics rides the SAME circuit breaker as publishing (a provider that's down for
// publishing is down for reads too) but on its OWN rate-limit budget (metricsRateLimit), so a burst
// of snapshots can never drain the tokens the publish queue needs. It also uses the read-only
// circuit check, so it never steals the publisher's half-open recovery probe.
import { sql } from 'drizzle-orm';
import { withTenant, SYSTEM_USER_ID, type TenantContext } from '../db/tenant';
import { toTs } from '../db/index';
import { resolveAdapter, listProviders } from '../providers/registry';
import { ensureFreshToken } from '../accounts/refresh';
import { NormalizedError } from '../providers/errors';
import { circuitClosed, circuitSuccess, circuitFailure } from '../publishing/circuit';
import { metricsRateLimit } from './ratelimit';
import { snapshotColumns } from './normalize';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];

export interface MaintenanceDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts a drizzle sql query.
  execute: (q: any) => Promise<any>;
}

const HOUR = 3600_000;
const DAY = 86_400_000;
// While a claimed pull is in flight, hold the cursor this far ahead so a second worker skips it.
const CLAIM_LEASE_SQL = sql`now() + interval '10 minutes'`;
// A failed pull retries about an hour later — never records zeros for a fetch that simply failed.
const RETRY_AFTER_FAIL_SQL = sql`now() + interval '1 hour'`;

// The next snapshot time for a post, or null once it has aged past the window. Pure + total, so the
// tests can hand-verify it. `now` is threaded in (never read from the clock here) for determinism.
export function nextMetricsAt(publishedAt: Date, now: Date): Date | null {
  const base = publishedAt.getTime();
  const points = [base + HOUR, base + DAY, base + 7 * DAY];
  for (let d = 14; d <= 90; d += 7) points.push(base + d * DAY);
  const next = points.find((t) => t > now.getTime());
  return next === undefined ? null : new Date(next);
}

const providersWithMetrics = (): string[] => listProviders().filter((p) => resolveAdapter(p).capabilities.supportsMetrics);

interface DueTarget {
  id: string; post_id: string; workspace_id: string; connected_account_id: string;
  provider: string; provider_account_id: string; provider_post_id: string | null; published_at: string;
}

// One ingestion tick. Claims due targets (advancing their cursor so no other worker double-pulls),
// then pulls + snapshots each in its own tenant transaction. Returns the number of snapshots written.
export async function metricsSnapshotTick(maint: MaintenanceDb, opts: { batch?: number; now?: Date } = {}): Promise<number> {
  const batch = opts.batch ?? 100;
  const now = opts.now ?? new Date();

  // CLAIM: lock due rows (SKIP LOCKED) and push their cursor 10 minutes out in the same statement.
  const due = rows<DueTarget>(await maint.execute(sql`
    with due as (
      select pt.id, ca.provider, ca.provider_account_id
      from post_targets pt
      join connected_accounts ca on ca.id = pt.connected_account_id
      where pt.state = 'published' and pt.metrics_next_at is not null and pt.metrics_next_at <= now()
        and ca.status = 'active'
      order by pt.metrics_next_at
      for update of pt skip locked
      limit ${batch}
    )
    update post_targets pt set metrics_next_at = ${CLAIM_LEASE_SQL}
    from due where pt.id = due.id
    returning pt.id, pt.post_id, pt.workspace_id, pt.connected_account_id,
              pt.provider_post_id, pt.published_at, due.provider, due.provider_account_id
  `));

  let captured = 0;
  for (const t of due) {
    // A target for a provider with no registered adapter (removed network / stale row) is left with
    // its lease and surfaced by monitoring, never crashing the whole tick.
    let adapter;
    try {
      adapter = resolveAdapter(t.provider);
    } catch {
      continue;
    }
    // Defensive: a target scheduled against a network with no metrics gets its cursor cleared.
    if (!adapter.capabilities.supportsMetrics || !adapter.fetchMetrics || !t.provider_post_id) {
      await maint.execute(sql`update post_targets set metrics_next_at = null where id = ${t.id}`);
      continue;
    }
    // Same breaker as publishing (read-only), and analytics' own budget. Either closed -> retry later.
    if (!(await circuitClosed(t.provider))) continue;                 // leaves the 10-min lease
    const rl = await metricsRateLimit(t.provider, t.connected_account_id, adapter.capabilities);
    if (!rl.allowed) continue;                                        // leaves the 10-min lease

    const ctx: TenantContext = { workspaceId: t.workspace_id, userId: SYSTEM_USER_ID, role: 'system' };
    try {
      const creds = await ensureFreshToken(ctx, t.provider, t.connected_account_id);
      const res = await adapter.fetchMetrics({ providerPostId: t.provider_post_id, account: { providerAccountId: t.provider_account_id, credentials: creds } });
      const c = snapshotColumns(res.metrics);
      await withTenant(ctx, async (tx) => {
        // IMMUTABLE INSERT. Unavailable fields land as NULL (never 0). A duplicate at the same instant
        // is a no-op (the UNIQUE(target, captured_at) constraint), never an overwrite.
        await tx.execute(sql`
          insert into metric_snapshots
            (workspace_id, post_target_id, connected_account_id, captured_at, metrics,
             impressions, reach, engagements, clicks, saves, shares, raw)
          values (${t.workspace_id}, ${t.id}, ${t.connected_account_id}, now(), ${JSON.stringify(res.metrics)}::jsonb,
             ${c.impressions}, ${c.reach}, ${c.engagements}, ${c.clicks}, ${c.saves}, ${c.shares},
             ${res.raw ? JSON.stringify(res.raw) : null}::jsonb)
          on conflict (post_target_id, captured_at) do nothing
        `);
        // Advance the cursor to the next milestone (or null once aged out).
        await tx.execute(sql`update post_targets set metrics_next_at = ${toTs(nextMetricsAt(new Date(t.published_at), now))} where id = ${t.id}`);
      });
      await circuitSuccess(t.provider);
      captured += 1;
    } catch (e) {
      // A failed fetch is NOT zero engagement — record nothing and retry in ~1h. A provider outage
      // trips the shared breaker so both analytics and publishing back off together.
      if (e instanceof NormalizedError && e.code === 'provider_unavailable') await circuitFailure(t.provider);
      await maint.execute(sql`update post_targets set metrics_next_at = ${RETRY_AFTER_FAIL_SQL} where id = ${t.id}`);
    }
  }
  return captured;
}

// Tenant-scoped backfill (on-demand, from the API). RLS restricts it to the caller's workspace; it
// only MARKS targets due, so the throttled ingestion tick still governs the actual pulls.
export async function backfillWorkspaceMetrics(ctx: TenantContext, opts: { limit?: number } = {}): Promise<number> {
  const limit = opts.limit ?? 500;
  const metricsProviders = providersWithMetrics();
  if (metricsProviders.length === 0) return 0;
  const providerLiteral = '{' + metricsProviders.map((p) => `"${p}"`).join(',') + '}';
  return withTenant(ctx, async (tx) => {
    const marked = rows(await tx.execute(sql`
      with due as (
        select pt.id, row_number() over (order by pt.published_at desc) as rn
        from post_targets pt
        join connected_accounts ca on ca.id = pt.connected_account_id
        where pt.state = 'published' and pt.metrics_next_at is null and pt.published_at is not null
          and ca.status = 'active' and ca.provider = any(${providerLiteral}::text[])
        limit ${limit}
      )
      update post_targets pt set metrics_next_at = now() + make_interval(secs => due.rn * 2)
      from due where pt.id = due.id
      returning pt.id
    `));
    return marked.length;
  });
}

// BACKFILL. Make eligible-but-unscheduled published targets due for a snapshot — posts published
// before analytics existed, or whose cursor was cleared while a provider was down. It only MARKS them
// due; the ingestion tick's rate limiter + breaker do the throttling, so this can never stampede a
// provider. Staggered by a couple seconds each to smear the initial due-spike. Returns rows marked.
export async function backfillMetrics(maint: MaintenanceDb, opts: { limit?: number } = {}): Promise<number> {
  const limit = opts.limit ?? 500;
  const metricsProviders = providersWithMetrics();
  if (metricsProviders.length === 0) return 0;
  const providerLiteral = '{' + metricsProviders.map((p) => `"${p}"`).join(',') + '}';

  const marked = rows(await maint.execute(sql`
    with due as (
      select pt.id, row_number() over (order by pt.published_at desc) as rn
      from post_targets pt
      join connected_accounts ca on ca.id = pt.connected_account_id
      where pt.state = 'published' and pt.metrics_next_at is null and pt.published_at is not null
        and ca.status = 'active' and ca.provider = any(${providerLiteral}::text[])
      limit ${limit}
    )
    update post_targets pt set metrics_next_at = now() + make_interval(secs => due.rn * 2)
    from due where pt.id = due.id
    returning pt.id
  `));
  return marked.length;
}
