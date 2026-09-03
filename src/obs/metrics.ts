// src/obs/metrics.ts
// The metrics that actually tell us the product is broken — computed fleet-wide, so they read via the
// maintenance (RLS-bypassing) connection, never a tenant context. Exposed as Prometheus text at
// GET /internal/metrics (ops-token gated). ALERTS lists what's worth waking someone for, and why.
import { sql } from 'drizzle-orm';

type Row = Record<string, unknown>;
const rows = <T = Row>(r: unknown): T[] => r as unknown as T[];
const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export interface MaintenanceDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts a drizzle sql query
  execute: (q: any) => Promise<any>;
}

export interface ProviderPublish { provider: string; published: number; failed: number; successRate: number }
export interface Metrics {
  publishByProvider: ProviderPublish[];
  queueDepth: number;         // targets scheduled (all)
  queueDueNow: number;        // scheduled and already due (real backlog)
  oldestUnclaimedSec: number; // age of the oldest overdue scheduled target
  stuckInFlight: number;      // publishing/reconciling with an expired lease (sweeper not keeping up)
  tokenAuthExpired: number;   // accounts whose refresh failed -> need reconnect
  tokenRefreshFailRate: number;
  webhookDelivered24h: number;
  webhookExhausted24h: number;
  webhookFailRate: number;
  webhookBacklog: number;     // pending/failed deliveries waiting
  deadLetters: number;        // unresolved dead-letter targets
}

export async function collectMetrics(maint: MaintenanceDb): Promise<Metrics> {
  const byProvider = rows<{ provider: string; published: string; failed: string }>(await maint.execute(sql`
    select ca.provider,
           count(*) filter (where pt.state = 'published')               as published,
           count(*) filter (where pt.state in ('failed','needs_review')) as failed
    from post_targets pt join connected_accounts ca on ca.id = pt.connected_account_id
    where pt.updated_at >= now() - interval '24 hours'
    group by ca.provider order by ca.provider`));

  const queue = rows<{ depth: string; due: string; oldest: string | null }>(await maint.execute(sql`
    select count(*) filter (where state = 'scheduled')                              as depth,
           count(*) filter (where state = 'scheduled' and publish_due_at <= now())  as due,
           extract(epoch from (now() - min(publish_due_at) filter (where state='scheduled' and publish_due_at <= now())))::int as oldest
    from post_targets`))[0];

  const stuck = rows<{ c: string }>(await maint.execute(sql`
    select count(*)::int as c from post_targets
    where state in ('publishing','reconciling') and (lease_expires_at is null or lease_expires_at < now())`))[0];

  const tokens = rows<{ expired: string; active: string }>(await maint.execute(sql`
    select count(*) filter (where status = 'auth_expired') as expired,
           count(*) filter (where status in ('active','auth_expired')) as active
    from connected_accounts`))[0];

  const wh = rows<{ delivered: string; exhausted: string; backlog: string }>(await maint.execute(sql`
    select count(*) filter (where status = 'succeeded' and delivered_at >= now() - interval '24 hours') as delivered,
           count(*) filter (where status = 'exhausted' and created_at   >= now() - interval '24 hours') as exhausted,
           count(*) filter (where status in ('pending','failed')) as backlog
    from webhook_deliveries`))[0];

  const dl = rows<{ c: string }>(await maint.execute(sql`select count(*)::int as c from dead_letters where requeued_at is null`))[0];

  const publishByProvider = byProvider.map((p) => {
    const published = n(p.published); const failed = n(p.failed); const total = published + failed;
    return { provider: p.provider, published, failed, successRate: total ? published / total : 1 };
  });
  const activeAcc = n(tokens?.active);
  const delivered = n(wh?.delivered); const exhausted = n(wh?.exhausted); const whTotal = delivered + exhausted;
  return {
    publishByProvider,
    queueDepth: n(queue?.depth),
    queueDueNow: n(queue?.due),
    oldestUnclaimedSec: n(queue?.oldest),
    stuckInFlight: n(stuck?.c),
    tokenAuthExpired: n(tokens?.expired),
    tokenRefreshFailRate: activeAcc ? n(tokens?.expired) / activeAcc : 0,
    webhookDelivered24h: delivered,
    webhookExhausted24h: exhausted,
    webhookFailRate: whTotal ? exhausted / whTotal : 0,
    webhookBacklog: n(wh?.backlog),
    deadLetters: n(dl?.c),
  };
}

// The alerts worth paging on, with thresholds and the reason each matters.
export const ALERTS = [
  { metric: 'publish_success_rate{provider}', condition: '< 0.90 for 15m', why: 'a provider (or our integration to it) is broken; posts are silently not going out' },
  { metric: 'oldest_unclaimed_seconds', condition: '> 300 (5m)', why: 'the due-scan/workers are not keeping up or are down; scheduled posts are late' },
  { metric: 'targets_stuck_in_flight', condition: '> 0 for 10m', why: 'the lease sweeper is not reclaiming dead workers; targets are frozen mid-publish' },
  { metric: 'token_refresh_fail_rate', condition: '> 0.10', why: 'a provider changed its auth, or our refresh worker is broken across many accounts' },
  { metric: 'webhook_fail_rate', condition: '> 0.25 for 30m', why: 'customers are missing events; often one flapping endpoint, sometimes our delivery worker' },
  { metric: 'dead_letters', condition: '> 0', why: 'a post exhausted all retries and needs a human; every one is a customer-visible miss' },
  { metric: 'queue_due_now', condition: '> 1000 and rising', why: 'backlog is growing faster than we drain it; scale workers' },
] as const;

const esc = (s: string): string => s.replace(/["\\\n]/g, '\\$&');

export function renderPrometheus(m: Metrics): string {
  const lines: string[] = [];
  const g = (name: string, help: string, value: number, labels = '') => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name}${labels} ${value}`);
  };
  for (const p of m.publishByProvider) {
    lines.push(`# TYPE meridian_publish_success_rate gauge`, `meridian_publish_success_rate{provider="${esc(p.provider)}"} ${p.successRate}`);
    lines.push(`meridian_publish_published_total{provider="${esc(p.provider)}"} ${p.published}`, `meridian_publish_failed_total{provider="${esc(p.provider)}"} ${p.failed}`);
  }
  g('meridian_queue_depth', 'scheduled targets awaiting publish', m.queueDepth);
  g('meridian_queue_due_now', 'scheduled targets already overdue', m.queueDueNow);
  g('meridian_oldest_unclaimed_seconds', 'age of the oldest overdue scheduled target', m.oldestUnclaimedSec);
  g('meridian_targets_stuck_in_flight', 'publishing/reconciling with an expired lease', m.stuckInFlight);
  g('meridian_token_auth_expired', 'accounts needing reconnection', m.tokenAuthExpired);
  g('meridian_token_refresh_fail_rate', 'fraction of accounts in auth_expired', m.tokenRefreshFailRate);
  g('meridian_webhook_fail_rate', 'exhausted / (delivered+exhausted) over 24h', m.webhookFailRate);
  g('meridian_webhook_backlog', 'pending+failed deliveries', m.webhookBacklog);
  g('meridian_dead_letters', 'unresolved dead-letter targets', m.deadLetters);
  return lines.join('\n') + '\n';
}
