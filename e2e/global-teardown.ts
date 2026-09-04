// e2e/global-teardown.ts
// Stops the publish worker started in global-setup. Best-effort — a leftover worker in CI is cleaned up
// when the job container exits anyway.
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export default async function globalTeardown(): Promise<void> {
  const pidFile = join(process.cwd(), '.e2e-worker.pid');
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  try {
    // Negative pid kills the detached process group on POSIX; on win32 the plain pid is used.
    process.kill(process.platform === 'win32' ? pid : -pid);
  } catch {
    /* already gone */
  }
  rmSync(pidFile, { force: true });
}
