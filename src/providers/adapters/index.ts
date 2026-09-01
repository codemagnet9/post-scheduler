// src/providers/adapters/index.ts
// The registration list — one of the exactly TWO places touched when adding a network. Import this
// module once at startup (server.ts / worker bootstrap) to populate the registry.
import { registerAdapter } from '../registry';
import { blueskyAdapter } from './bluesky';
import { lineAdapter } from './line';
import { fakeAdapter } from './fake';

registerAdapter(blueskyAdapter);
registerAdapter(lineAdapter);

// The fake provider is only registered in tests, never in production.
if (process.env.NODE_ENV === 'test') {
  registerAdapter(fakeAdapter());
}

export {};
