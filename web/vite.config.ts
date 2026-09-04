/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies the API paths to the Fastify backend on :3000, so the browser treats web and
// API as one origin — the refresh cookie is same-origin and CORS never enters the picture in dev.
const API = 'http://localhost:3000';
const proxy = Object.fromEntries(
  ['/auth', '/me', '/workspaces', '/invitations', '/connections', '/v1', '/internal'].map((p) => [p, { target: API, changeOrigin: true }]),
);

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  // fileParallelism:false runs test files sequentially in one worker. The jsdom component tests are
  // heavy enough that the parallel worker pool intermittently crashes on some machines; sequential is
  // stable and the suite is fast either way. Matches the backend's vitest convention.
  test: { environment: 'node', include: ['src/**/*.test.{ts,tsx}'], fileParallelism: false },
});
