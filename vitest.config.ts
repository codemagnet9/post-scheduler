// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // Integration tests share one Postgres; run files serially to keep tenant state predictable.
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
