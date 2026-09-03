// src/worker.ts
// The background worker process. Boots graphile-worker with a crontab and the task list, and wires
// the three previously-unwired jobs (lease sweeper — Phase 2; token refresh + re-encryption —
// Phase 4) alongside the Phase 6 due-scan/publish pipeline.
//
// Schedules (graphile-worker cron, 1-minute resolution):
//   due-scan          every 1 min   — claim due targets and fan out publish jobs
//   lease-sweeper     every 1 min   — reclaim targets a dead worker stranded (lease expired)
//   refresh-tokens    every 5 min   — refresh OAuth tokens ahead of expiry (single-flight)
//   reencrypt-tokens  every 1 hour  — migrate any token rows still under an old key id
//   cleanup-orphans   daily 03:00   — delete unreferenced / failed media assets
//   variant-retention daily 03:30   — drop cached variants of already-published posts
//   metrics-snapshot  every 5 min   — pull due targets' metrics into immutable snapshots
//   metrics-backfill  daily 04:00   — mark pre-analytics/missed posts due for a snapshot (no stampede)
//   process-exports   every 1 min   — build queued CSV exports and publish a download link
//   webhook-fanout    every 1 min   — outbox -> per-endpoint deliveries (own fanned_out cursor)
//   webhook-deliver   every 1 min   — sign + POST due deliveries, backoff 24h, disable on exhaustion
//   idempotency-gc    every 1 hour  — purge expired api_idempotency_keys (24h retention)
//
// graphile-worker manages its own job tables, so it runs on the admin connection. Business writes
// still go through meridian_app via withTenant inside the tasks.
import 'dotenv/config';
import { run, type Task } from 'graphile-worker';
import { maintenanceDb } from './db/maintenance';
import { claimDueTargets, publishClaimed, leaseSweeperTick, type ClaimedTarget } from './publishing/pipeline';
import { refreshWorkerTick } from './accounts/refresh';
import { reencryptTokens } from './vault/tokens';
import { cleanupOrphans, retainVariants } from './media/service';
import { initMediaBackends } from './media/bootstrap';
import { dispatchNotificationsTick } from './notifications/dispatcher';
import { weeklySummaryTick, queueLowTick } from './notifications/summary';
import { metricsSnapshotTick, backfillMetrics } from './analytics/ingest';
import { processExportsTick } from './analytics/export';
import { fanOutTick, deliverTick } from './webhooks/dispatcher';
import { gcIdempotencyKeys } from './api/idempotency';
import './providers/adapters/index'; // register network adapters in the worker process

const WORKER_ID = `worker-${process.pid}`;

const dueScan: Task = async (_payload, helpers) => {
  const claimed = await maintenanceDb.transaction((tx) => claimDueTargets(tx, { batch: 100, workerId: WORKER_ID }));
  // Fan out one publish job per claimed target so many workers publish concurrently.
  for (const c of claimed) await helpers.addJob('publish-target', c);
};

const publishTarget: Task = async (payload) => {
  await publishClaimed(payload as unknown as ClaimedTarget);
};

const leaseSweeper: Task = async () => {
  await leaseSweeperTick(maintenanceDb, { workerId: WORKER_ID });
};

const refreshTokens: Task = async () => {
  await refreshWorkerTick(maintenanceDb as unknown as { execute: (q: unknown) => Promise<unknown> });
};

const reencrypt: Task = async () => {
  await reencryptTokens(maintenanceDb as unknown as { execute: (q: unknown) => Promise<unknown> });
};

const cleanupOrphansTask: Task = async () => {
  await cleanupOrphans(maintenanceDb);
};

const variantRetentionTask: Task = async () => {
  await retainVariants(maintenanceDb);
};

const dispatchNotifications: Task = async () => {
  await dispatchNotificationsTick(maintenanceDb);
};

const weeklySummary: Task = async () => {
  const now = new Date();
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
  await weeklySummaryTick(maintenanceDb, monday.toISOString().slice(0, 10));
};

const queueLow: Task = async () => {
  await queueLowTick(maintenanceDb, new Date().toISOString().slice(0, 10));
};

const metricsSnapshot: Task = async () => {
  await metricsSnapshotTick(maintenanceDb);
};

const metricsBackfill: Task = async () => {
  await backfillMetrics(maintenanceDb);
};

const processExports: Task = async () => {
  await processExportsTick(maintenanceDb);
};

const webhookFanout: Task = async () => {
  await fanOutTick(maintenanceDb);
};

const webhookDeliver: Task = async () => {
  await deliverTick(maintenanceDb);
};

const idempotencyGc: Task = async () => {
  await gcIdempotencyKeys(maintenanceDb as unknown as { execute: (q: unknown) => Promise<unknown> });
};

async function main(): Promise<void> {
  initMediaBackends(); // storage + sharp/ffmpeg + ffprobe (fails fast if prod is on memory storage)
  const runner = await run({
    connectionString: process.env.DATABASE_URL_ADMIN,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10),
    noHandleSignals: false,
    crontab: [
      '* * * * * due-scan',
      '* * * * * lease-sweeper',
      '*/5 * * * * refresh-tokens',
      '0 * * * * reencrypt-tokens',
      '0 3 * * * cleanup-orphans',
      '30 3 * * * variant-retention',
      '* * * * * dispatch-notifications',
      '0 8 * * 1 weekly-summary',
      '0 9 * * * queue-low',
      '*/5 * * * * metrics-snapshot',
      '0 4 * * * metrics-backfill',
      '* * * * * process-exports',
      '* * * * * webhook-fanout',
      '* * * * * webhook-deliver',
      '0 * * * * idempotency-gc',
    ].join('\n'),
    taskList: {
      'due-scan': dueScan,
      'publish-target': publishTarget,
      'lease-sweeper': leaseSweeper,
      'refresh-tokens': refreshTokens,
      'reencrypt-tokens': reencrypt,
      'cleanup-orphans': cleanupOrphansTask,
      'variant-retention': variantRetentionTask,
      'dispatch-notifications': dispatchNotifications,
      'weekly-summary': weeklySummary,
      'queue-low': queueLow,
      'metrics-snapshot': metricsSnapshot,
      'metrics-backfill': metricsBackfill,
      'process-exports': processExports,
      'webhook-fanout': webhookFanout,
      'webhook-deliver': webhookDeliver,
      'idempotency-gc': idempotencyGc,
    },
  });
  await runner.promise;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
