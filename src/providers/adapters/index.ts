// src/providers/adapters/index.ts
// The registration list — one of the exactly TWO places touched when adding a network. Import this
// module once at startup (server.ts / worker bootstrap) to populate the registry.
import { registerAdapter } from '../registry';
import { blueskyAdapter } from './bluesky';
import { lineAdapter } from './line';
import { fakeAdapter } from './fake';

registerAdapter(blueskyAdapter);
registerAdapter(lineAdapter);

// The fake provider is registered in tests, and in an E2E harness that opts in explicitly with
// MERIDIAN_ENABLE_FAKE_PROVIDER=1 (the Playwright demo-path run). It is NEVER registered in a normal
// production boot — a real deploy sets neither flag, so the connect catalog never offers it.
if (process.env.NODE_ENV === 'test' || process.env.MERIDIAN_ENABLE_FAKE_PROVIDER === '1') {
  registerAdapter(fakeAdapter());
}

export {};
