// e2e/global-setup.ts
// Starts the publish worker (it has no HTTP surface, so Playwright's webServer can't manage it) with
// the fake provider enabled, and records its pid for teardown. The API + web servers are managed by
// Playwright's webServer config.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default async function globalSetup(): Promise<void> {
  const worker = spawn('npm', ['run', 'worker'], {
    env: { ...process.env, MERIDIAN_ENABLE_FAKE_PROVIDER: '1' },
    stdio: 'inherit',
    shell: true,
    detached: true,
  });
  if (worker.pid) writeFileSync(join(process.cwd(), '.e2e-worker.pid'), String(worker.pid));
  // Give the worker a moment to connect to the queue before tests start scheduling posts.
  await new Promise((r) => setTimeout(r, 3000));
}
