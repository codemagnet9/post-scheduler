import { describe, it, expect } from 'vitest';
import { resolveDeepLink } from './deepLink';

// Test #5 (core): a notification's server deep link resolves to the exact in-app route — a post opens
// in the composer on THAT post, a queue-low opens the queue. This is the mapping the bell clicks through.
describe('notification deep links resolve to the right in-app route', () => {
  it('a post deep link opens the composer on that exact post', () => {
    expect(resolveDeepLink('/w/ws1/posts/p-42')).toEqual({ workspaceId: 'ws1', to: '/composer?post=p-42' });
  });
  it('a queue deep link opens the queue', () => {
    expect(resolveDeepLink('/w/ws1/queue')).toEqual({ workspaceId: 'ws1', to: '/queue' });
  });
  it('home + accounts links map to their screens', () => {
    expect(resolveDeepLink('/w/ws1/home')).toEqual({ workspaceId: 'ws1', to: '/' });
    expect(resolveDeepLink('/w/ws1/settings/accounts')).toEqual({ workspaceId: 'ws1', to: '/networks' });
  });
  it('encodes a post id with unusual characters and never throws on a null/garbage link', () => {
    expect(resolveDeepLink('/w/ws1/posts/a b')).toEqual({ workspaceId: 'ws1', to: '/composer?post=a%20b' });
    expect(resolveDeepLink(null)).toEqual({ workspaceId: null, to: '/' });
    expect(resolveDeepLink('nonsense')).toEqual({ workspaceId: null, to: '/' });
  });
});
