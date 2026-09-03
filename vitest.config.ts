// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The backend suite lives in test/. The frontend (web/) has its own vitest + jsdom config.
    include: ['test/**/*.test.ts'],
    exclude: ['web/**', 'node_modules/**'],
    setupFiles: ['./test/setup.ts'],
    // Truncate all app tables once before the run, so state never leaks across runs.
    globalSetup: ['./test/global-setup.ts'],
    // Integration tests share one Postgres; run files serially to keep tenant state predictable.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
