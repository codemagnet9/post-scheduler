// src/worker.ts
// The background worker process. Boots graphile-worker with a crontab and the task list, and wires
// the three previously-unwired jobs (lease sweeper — Phase 2; token refresh + re-encryption —
// Phase 4) alongside the Phase 6 due-scan/publish pipeline.
//
// Schedules (graphile-worker cron, 1-minute resolution):
//   due-scan        every 1 min   — claim due targets and fan out publish jobs
//   lease-sweeper   every 1 min   — reclaim targets a dead worker stranded (lease expired)
//   refresh-tokens  every 5 min   — refresh OAuth tokens ahead of expiry (single-flight)
//   reencrypt-tokens every 1 hour — migrate any token rows still under an old key id
//
// graphile-worker manages its own job tables, so it runs on the admin connection. Business writes
// still go through meridian_app via withTenant inside the tasks.
import 'dotenv/config';
import { run, type Task } from 'graphile-worker';
import { maintenanceDb } from './db/maintenance';
import { claimDueTargets, publishClaimed, leaseSweeperTick, type ClaimedTarget } from './publishing/pipeline';
import { refreshWorkerTick } from './accounts/refresh';
import { reencryptTokens } from './vault/tokens';
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

async function main(): Promise<void> {
  const runner = await run({
    connectionString: process.env.DATABASE_URL_ADMIN,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 10),
    noHandleSignals: false,
    crontab: [
      '* * * * * due-scan',
      '* * * * * lease-sweeper',
      '*/5 * * * * refresh-tokens',
      '0 * * * * reencrypt-tokens',
    ].join('\n'),
    taskList: {
      'due-scan': dueScan,
      'publish-target': publishTarget,
      'lease-sweeper': leaseSweeper,
      'refresh-tokens': refreshTokens,
      'reencrypt-tokens': reencrypt,
    },
  });
  await runner.promise;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
