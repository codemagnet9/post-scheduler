// test/analytics.test.ts
// Phase 9 analytics. Integration (Postgres) except the two pure-function checks.
//   - snapshots are immutable and read back in captured order
//   - an unavailable metric renders as null, NEVER 0 (headline, top posts, CSV)
//   - engagement rate matches its single definition on a hand-worked example
//   - every read model is correct against one seeded, fixed-date fixture
//   - the snapshot worker respects the shared circuit breaker (no pull while open)
//   - CSV export runs as a background job and backfill marks missed posts due
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, toTs } from '../src/db/index';
import { withTenant, type TenantContext } from '../src/db/tenant';
import { createWorkspace } from '../src/workspaces/service';
import { storeTokens } from '../src/vault/tokens';
import { createFakeProvider, type FakeControl } from '../src/providers/adapters/fake';
import { registerAdapter } from '../src/providers/registry';
import { setStorage, MemoryStorage, getStorage } from '../src/media/storage';
import { engagementRate, snapshotColumns, type NormalizedMetrics } from '../src/analytics/normalize';
import { nextMetricsAt, metricsSnapshotTick, backfillWorkspaceMetrics } from '../src/analytics/ingest';
import { headline, dailySeriesByNetwork, postsPerNetwork, topPostsByEngagementRate, engagementHeatmap } from '../src/analytics/read-models';
import { createExport, getExport, processExportsTick } from '../src/analytics/export';
import { adminDb, asRows } from './helpers/db';

let seq = 0;
const uniq = () => `${Date.now()}-${seq++}`;
const D = (s: string) => new Date(s);

async function createUser(): Promise<string> {
  return asRows<{ id: string }>(await db.execute(sql`insert into users (email) values (${`a-${uniq()}@meridian.test`}) returning id`))[0].id;
}
async function makeWorkspace(): Promise<{ ctx: TenantContext; workspaceId: string; userId: string }> {
  const userId = await createUser();
  const { workspaceId } = await createWorkspace(userId, 'Analytics');
  return { ctx: { workspaceId, userId, role: 'owner' }, workspaceId, userId };
}

interface Network { key: string; fake: ReturnType<typeof createFakeProvider>; control: FakeControl; accountId: string; providerAccountId: string }
async function addNetwork(ctx: TenantContext, opts: { supportsMetrics?: boolean } = {}): Promise<Network> {
  const key = `an-${uniq()}`;
  const fake = createFakeProvider({ key, supportsMetrics: opts.supportsMetrics ?? true });
  registerAdapter(fake.adapter);
  const providerAccountId = `pa-${uniq()}`;
  const accountId = await withTenant(ctx, async (tx) => {
    const acc = asRows<{ id: string }>(await tx.execute(sql`
      insert into connected_accounts (workspace_id, provider, provider_account_id, timezone, status)
      values (${ctx.workspaceId}, ${key}, ${providerAccountId}, 'UTC', 'active') returning id`))[0];
    await storeTokens(tx, { connectedAccountId: acc.id, workspaceId: ctx.workspaceId, credentials: { accessToken: 'tok' } });
    return acc.id;
  });
  return { key, fake, control: fake.control, accountId, providerAccountId };
}

async function publishedTarget(ctx: TenantContext, n: Network, opts: { publishedAt: Date; providerPostId?: string; permalink?: string; metricsNextAt?: Date | null }): Promise<{ postId: string; targetId: string }> {
  return withTenant(ctx, async (tx) => {
    const post = asRows<{ id: string }>(await tx.execute(sql`insert into posts (workspace_id, status) values (${ctx.workspaceId}, 'published') returning id`))[0];
    const target = asRows<{ id: string }>(await tx.execute(sql`
      insert into post_targets (post_id, workspace_id, connected_account_id, state, rendered_payload, scheduled_at, publish_due_at, published_at, provider_post_id, provider_permalink, metrics_next_at)
      values (${post.id}, ${ctx.workspaceId}, ${n.accountId}, 'published', ${JSON.stringify({ text: 'x', media: [] })}::jsonb,
        ${toTs(opts.publishedAt)}, ${toTs(opts.publishedAt)}, ${toTs(opts.publishedAt)}, ${opts.providerPostId ?? `pp-${uniq()}`}, ${opts.permalink ?? null}, ${toTs(opts.metricsNextAt ?? null)})
      returning id`))[0];
    return { postId: post.id, targetId: target.id };
  });
}

async function seedSnapshot(ctx: TenantContext, n: Network, targetId: string, capturedAt: Date, m: NormalizedMetrics): Promise<void> {
  const c = snapshotColumns(m);
  await withTenant(ctx, (tx) => tx.execute(sql`
    insert into metric_snapshots (workspace_id, post_target_id, connected_account_id, captured_at, metrics, impressions, reach, engagements, clicks, saves, shares)
    values (${ctx.workspaceId}, ${targetId}, ${n.accountId}, ${toTs(capturedAt)}, ${JSON.stringify(m)}::jsonb, ${c.impressions}, ${c.reach}, ${c.engagements}, ${c.clicks}, ${c.saves}, ${c.shares})`));
}

// ---------------------------------------------------------------------------
describe('engagement rate — one definition', () => {
  it('matches the hand-worked example: 30 engagements over 1000 impressions = 0.03', () => {
    expect(engagementRate(30, 1000)).toBe(0.03);
  });
  it('is UNAVAILABLE (null), not zero, when impressions are missing or zero', () => {
    expect(engagementRate(30, null)).toBeNull();     // impressions unavailable
    expect(engagementRate(30, 0)).toBeNull();        // never divide by zero
    expect(engagementRate(null, 1000)).toBeNull();   // engagements unavailable
    expect(engagementRate(0, 1000)).toBe(0);         // a real zero engagement IS 0
  });
});

describe('ingestion schedule (nextMetricsAt)', () => {
  const pub = D('2025-06-02T10:00:00Z');
  const at = (ms: number) => new Date(pub.getTime() + ms);
  const H = 3600_000, DAY = 86_400_000;
  it('walks 1h -> 24h -> 7d -> weekly, then stops at ~90 days', () => {
    expect(nextMetricsAt(pub, at(30 * 60_000))!.getTime()).toBe(pub.getTime() + H);   // <1h -> +1h
    expect(nextMetricsAt(pub, at(2 * H))!.getTime()).toBe(pub.getTime() + 24 * H);     // <24h -> +24h
    expect(nextMetricsAt(pub, at(25 * H))!.getTime()).toBe(pub.getTime() + 7 * DAY);    // <7d -> +7d
    expect(nextMetricsAt(pub, at(8 * DAY))!.getTime()).toBe(pub.getTime() + 14 * DAY);  // weekly
    expect(nextMetricsAt(pub, at(100 * DAY))).toBeNull();                               // aged out
  });
});

// ---------------------------------------------------------------------------
describe('snapshots are immutable and ordered', () => {
  it('reads back in captured order and refuses a duplicate at the same instant', async () => {
    const { ctx } = await makeWorkspace();
    const n = await addNetwork(ctx);
    const { targetId } = await publishedTarget(ctx, n, { publishedAt: D('2025-06-02T10:00:00Z') });

    const t1 = D('2025-06-02T11:00:00Z');
    const t2 = D('2025-06-03T10:00:00Z');
    await seedSnapshot(ctx, n, targetId, t1, { engagements: 10, impressions: 500 });
    await seedSnapshot(ctx, n, targetId, t2, { engagements: 30, impressions: 1000 });

    const timeline = asRows<{ engagements: string; captured_at: string }>(await withTenant(ctx, (tx) => tx.execute(sql`
      select engagements, captured_at from metric_snapshots where post_target_id = ${targetId} order by captured_at asc`)));
    expect(timeline.map((r) => Number(r.engagements))).toEqual([10, 30]); // oldest first, both present

    // Immutability: a second snapshot at the SAME captured_at is rejected by the unique constraint —
    // history is append-only, an existing snapshot can never be overwritten.
    let threw = false;
    try {
      await seedSnapshot(ctx, n, targetId, t1, { engagements: 999, impressions: 999 });
    } catch { threw = true; }
    expect(threw).toBe(true);
    const still = asRows<{ engagements: string }>(await withTenant(ctx, (tx) => tx.execute(sql`select engagements from metric_snapshots where post_target_id = ${targetId} and captured_at = ${toTs(t1)}`)));
    expect(Number(still[0].engagements)).toBe(10); // untouched
  });
});

// ---------------------------------------------------------------------------
describe('unavailable renders as null, never zero', () => {
  it('headline impressions are null (not 0) when the network supplies none; engagements still read', async () => {
    const { ctx } = await makeWorkspace();
    const n = await addNetwork(ctx);
    const { targetId } = await publishedTarget(ctx, n, { publishedAt: D('2025-06-05T12:00:00Z') });
    // engagements present, impressions UNAVAILABLE (null).
    await seedSnapshot(ctx, n, targetId, D('2025-06-06T12:00:00Z'), { engagements: 10, impressions: null });

    const h = await headline(ctx, { from: D('2025-06-01T00:00:00Z'), to: D('2025-07-01T00:00:00Z') });
    expect(h.impressions.value).toBeNull();        // NOT 0
    expect(h.engagementRate.value).toBeNull();     // no denominator -> unavailable, not 0%
    expect(h.engagements.value).toBe(10);          // a real number reads through
  });

  it('a supportsMetrics=false network is flagged not-available, not counted as zero', async () => {
    const { ctx } = await makeWorkspace();
    const noMetrics = await addNetwork(ctx, { supportsMetrics: false });
    await publishedTarget(ctx, noMetrics, { publishedAt: D('2025-06-05T12:00:00Z') });

    const per = await postsPerNetwork(ctx, { from: D('2025-06-01T00:00:00Z'), to: D('2025-07-01T00:00:00Z') });
    const row = per.find((r) => r.provider === noMetrics.key);
    expect(row).toBeDefined();
    expect(row!.posts).toBe(1);
    expect(row!.metricsSupported).toBe(false); // explicit "not available" state
  });
});

// ---------------------------------------------------------------------------
describe('read models against a seeded fixture', () => {
  it('headline, daily series, posts-per-network, top posts and heatmap are all correct', async () => {
    const { ctx } = await makeWorkspace();
    const range = { from: D('2025-06-01T00:00:00Z'), to: D('2025-07-01T00:00:00Z') };
    const pA = await addNetwork(ctx); // metrics network A
    const pB = await addNetwork(ctx); // metrics network B

    // Post1 on A, published Mon 2025-06-02 10:00Z, two snapshots (latest = 06-04: impr1000 eng30 clicks5).
    const ta = await publishedTarget(ctx, pA, { publishedAt: D('2025-06-02T10:00:00Z') });
    await seedSnapshot(ctx, pA, ta.targetId, D('2025-06-03T10:00:00Z'), { impressions: 500, engagements: 10, clicks: 2 });
    await seedSnapshot(ctx, pA, ta.targetId, D('2025-06-04T10:00:00Z'), { impressions: 1000, engagements: 30, clicks: 5 });
    // Post2 on B, published Thu 2025-06-05 14:00Z (impr2000 eng60 clicks10).
    const tb = await publishedTarget(ctx, pB, { publishedAt: D('2025-06-05T14:00:00Z') });
    await seedSnapshot(ctx, pB, tb.targetId, D('2025-06-06T14:00:00Z'), { impressions: 2000, engagements: 60, clicks: 10 });
    // Post3 on A, published Sun 2025-06-08 09:00Z, impressions UNAVAILABLE.
    const tc = await publishedTarget(ctx, pA, { publishedAt: D('2025-06-08T09:00:00Z') });
    await seedSnapshot(ctx, pA, tc.targetId, D('2025-06-09T09:00:00Z'), { impressions: null, engagements: 5 });

    // 1) HEADLINE — sums of latest snapshots; unavailable impressions skipped (3000, not 3010).
    const h = await headline(ctx, range);
    expect(h.impressions.value).toBe(3000);
    expect(h.engagements.value).toBe(95);      // 30 + 60 + 5
    expect(h.linkClicks.value).toBe(15);       // 5 + 10 (Tc clicks unavailable)
    expect(h.engagementRate.value).toBeCloseTo(95 / 3000, 10);
    expect(h.impressions.previous).toBeNull(); // no prior-period posts
    expect(h.impressions.changePct).toBeNull();

    // 2) DAILY SERIES BY NETWORK — one point per (network, day), latest-per-target that day.
    const series = await dailySeriesByNetwork(ctx, range);
    const point = (prov: string, day: string) => series.find((s) => s.provider === prov && s.day === day);
    expect(point(pA.key, '2025-06-03')!.engagements).toBe(10);
    expect(point(pA.key, '2025-06-04')!.engagements).toBe(30);
    expect(point(pA.key, '2025-06-09')!.engagements).toBe(5);
    expect(point(pB.key, '2025-06-06')!.engagements).toBe(60);

    // 3) POSTS PER NETWORK.
    const per = await postsPerNetwork(ctx, range);
    expect(per.find((r) => r.provider === pA.key)!.posts).toBe(2);
    expect(per.find((r) => r.provider === pB.key)!.posts).toBe(1);

    // 4) TOP POSTS BY ENGAGEMENT RATE — only posts with impressions; Post3 (no impressions) excluded.
    const top = await topPostsByEngagementRate(ctx, range);
    const ids = top.map((t) => t.postId);
    expect(ids).toContain(ta.postId);
    expect(ids).toContain(tb.postId);
    expect(ids).not.toContain(tc.postId);           // unavailable ER is not treated as 0
    expect(top.find((t) => t.postId === ta.postId)!.engagementRate).toBeCloseTo(0.03, 10);
    expect(top.find((t) => t.postId === tb.postId)!.engagementRate).toBeCloseTo(0.03, 10);

    // 5) HEATMAP — buckets by local (UTC) weekday+hour of publish; avg latest engagements.
    const heat = await engagementHeatmap(ctx, range);
    const cell = (dow: number, hour: number) => heat.find((c) => c.dow === dow && c.hour === hour);
    expect(cell(1, 10)!.avgEngagements).toBe(30); // Mon 10:00 -> Post1 latest
    expect(cell(4, 14)!.avgEngagements).toBe(60); // Thu 14:00 -> Post2
    expect(cell(0, 9)!.avgEngagements).toBe(5);   // Sun 09:00 -> Post3
  });
});

// ---------------------------------------------------------------------------
describe('the snapshot worker', () => {
  it('captures an immutable snapshot with the normalized shape', async () => {
    const { ctx } = await makeWorkspace();
    const n = await addNetwork(ctx);
    n.control.metrics = { impressions: 120, reach: 90, engagements: 14, clicks: 6, saves: 3, shares: 2 };
    const { targetId } = await publishedTarget(ctx, n, {
      publishedAt: new Date(Date.now() - 30 * 60_000), providerPostId: 'pp-worker',
      metricsNextAt: new Date(Date.now() - 60_000), // due now
    });

    n.control.metricsCalls = 0;
    await metricsSnapshotTick(adminDb);

    expect(n.control.metricsCalls).toBe(1);
    const snap = asRows<{ impressions: string; engagements: string; shares: string }>(await withTenant(ctx, (tx) => tx.execute(sql`select impressions, engagements, shares from metric_snapshots where post_target_id = ${targetId}`)));
    expect(snap).toHaveLength(1);
    expect(Number(snap[0].impressions)).toBe(120);
    expect(Number(snap[0].engagements)).toBe(14);
    // Cursor advanced off the 10-minute claim lease to a real future milestone.
    const cur = asRows<{ metrics_next_at: string | null }>(await withTenant(ctx, (tx) => tx.execute(sql`select metrics_next_at from post_targets where id = ${targetId}`)))[0];
    expect(cur.metrics_next_at).not.toBeNull();
  });

  it('respects the shared circuit breaker — no pull while the provider is open', async () => {
    const { ctx } = await makeWorkspace();
    const n = await addNetwork(ctx);
    const { targetId } = await publishedTarget(ctx, n, {
      publishedAt: new Date(Date.now() - 30 * 60_000), providerPostId: 'pp-cb',
      metricsNextAt: new Date(Date.now() - 60_000),
    });

    // Trip the breaker OPEN (cooling down) for this provider.
    await adminDb.execute(sql`insert into provider_circuits (provider, state, failure_count, opened_at, next_probe_at)
      values (${n.key}, 'open', 5, now(), now() + interval '60 seconds')`);

    n.control.metricsCalls = 0;
    await metricsSnapshotTick(adminDb);
    expect(n.control.metricsCalls).toBe(0); // never called the provider
    const none = asRows(await withTenant(ctx, (tx) => tx.execute(sql`select id from metric_snapshots where post_target_id = ${targetId}`)));
    expect(none).toHaveLength(0);           // and wrote no snapshot

    // Close the breaker + make it due again -> now it pulls.
    await adminDb.execute(sql`update provider_circuits set state = 'closed', failure_count = 0, opened_at = null, next_probe_at = null where provider = ${n.key}`);
    await withTenant(ctx, (tx) => tx.execute(sql`update post_targets set metrics_next_at = now() - interval '1 minute' where id = ${targetId}`));
    await metricsSnapshotTick(adminDb);
    expect(n.control.metricsCalls).toBe(1);
    const one = asRows(await withTenant(ctx, (tx) => tx.execute(sql`select id from metric_snapshots where post_target_id = ${targetId}`)));
    expect(one).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('CSV export as a background job', () => {
  it('builds the file with unavailable cells left EMPTY (never 0) and hands back a link', async () => {
    setStorage(new MemoryStorage());
    const { ctx } = await makeWorkspace();
    const n = await addNetwork(ctx);
    const t1 = await publishedTarget(ctx, n, { publishedAt: D('2025-06-10T10:00:00Z'), permalink: 'perma-1' });
    const t2 = await publishedTarget(ctx, n, { publishedAt: D('2025-06-11T10:00:00Z'), permalink: 'perma-2' });
    await seedSnapshot(ctx, n, t1.targetId, D('2025-06-12T10:00:00Z'), { impressions: 1000, reach: 800, engagements: 30, clicks: 5, saves: 2, shares: 1 });
    await seedSnapshot(ctx, n, t2.targetId, D('2025-06-12T10:00:00Z'), { engagements: 10 }); // impressions unavailable

    const created = await createExport(ctx, { from: D('2025-06-01T00:00:00Z'), to: D('2025-06-30T00:00:00Z') });
    expect(created.status).toBe('pending');

    await processExportsTick(adminDb);

    const done = await getExport(ctx, created.id);
    expect(done!.status).toBe('ready');
    expect(done!.rowCount).toBe(2);
    expect(done!.downloadUrl).toBeTruthy(); // a link, not an inline dump

    const key = asRows<{ storage_key: string }>(await withTenant(ctx, (tx) => tx.execute(sql`select storage_key from analytics_exports where id = ${created.id}`)))[0].storage_key;
    const csv = (await getStorage().getObject(key)).toString('utf8');
    const lines = csv.trim().split('\n');
    const header = lines[0].split(',');
    const iImp = header.indexOf('impressions');
    const iEng = header.indexOf('engagements');
    const iEr = header.indexOf('engagement_rate');

    const row1 = lines.find((l) => l.includes('perma-1'))!.split(',');
    expect(row1[iImp]).toBe('1000');
    expect(row1[iEr]).toBe('0.03');            // single definition, in the export too

    const row2 = lines.find((l) => l.includes('perma-2'))!.split(',');
    expect(row2[iEng]).toBe('10');
    expect(row2[iImp]).toBe('');               // unavailable -> EMPTY cell, not 0
    expect(row2[iEr]).toBe('');                // and no engagement rate
  });
});

// ---------------------------------------------------------------------------
describe('backfill', () => {
  it('marks a pre-analytics published post due for a snapshot without stampeding', async () => {
    const { ctx } = await makeWorkspace();
    const n = await addNetwork(ctx);
    // Published before analytics existed: no cursor.
    const { targetId } = await publishedTarget(ctx, n, { publishedAt: D('2025-06-01T10:00:00Z'), metricsNextAt: null });

    const before = asRows<{ metrics_next_at: string | null }>(await withTenant(ctx, (tx) => tx.execute(sql`select metrics_next_at from post_targets where id = ${targetId}`)))[0];
    expect(before.metrics_next_at).toBeNull();

    const marked = await backfillWorkspaceMetrics(ctx);
    expect(marked).toBeGreaterThanOrEqual(1);

    const after = asRows<{ metrics_next_at: string | null }>(await withTenant(ctx, (tx) => tx.execute(sql`select metrics_next_at from post_targets where id = ${targetId}`)))[0];
    expect(after.metrics_next_at).not.toBeNull(); // now scheduled; the throttled worker does the pull
  });
});
