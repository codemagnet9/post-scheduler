// playwright.config.ts
// The demo-path E2E harness. It boots the real stack — API (with the fake provider enabled), the
// publish worker, and the web dev server — and drives one browser through the whole product path.
// The worker has no HTTP surface, so it's started in global-setup and killed in global-teardown; the
// API and web are managed as webServers (Playwright waits for each to answer before the test runs).
//
// Run: `npm run test:e2e` (needs a reachable Postgres via DATABASE_URL and, once, `npx playwright
// install chromium`). In CI, point DATABASE_URL at a fresh migrated database.
import { defineConfig, devices } from '@playwright/test';

const FAKE_ENV = { MERIDIAN_ENABLE_FAKE_PROVIDER: '1' };

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    // Frugal Chromium flags for constrained/CI sandboxes (limited RAM and /dev/shm).
    launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // API on :3000 — the vite dev server proxies /workspaces, /auth, /connections, … to it.
      command: 'npm run start',
      env: { ...FAKE_ENV, PORT: '3000' },
      url: 'http://localhost:3000/me', // returns 401 unauth — that's "up" as far as Playwright cares
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'npm run dev',
      cwd: './web',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
