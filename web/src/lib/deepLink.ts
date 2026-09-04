// src/lib/deepLink.ts
// A notification's deep link is authored server-side as `/w/{workspaceId}/{path}` where path is one of
// a small, known set. The in-app router uses different paths (the composer opens a post via ?post=…),
// so this is the ONE place that translates a server deep link into an in-app route. Keeping it pure and
// central means "click a notification → land on the exact thing it's about" is unit-testable.
export interface DeepLinkTarget { workspaceId: string | null; to: string }

export function resolveDeepLink(deepLink: string | null): DeepLinkTarget {
  if (!deepLink) return { workspaceId: null, to: '/' };
  // /w/{ws}/{rest...}
  const m = /^\/w\/([^/]+)\/(.*)$/.exec(deepLink);
  if (!m) return { workspaceId: null, to: '/' };
  const workspaceId = m[1];
  const rest = m[2];

  // posts/{id} -> the composer, opened on that post (the composer reads ?post=).
  const postMatch = /^posts\/([^/?#]+)/.exec(rest);
  if (postMatch) return { workspaceId, to: `/composer?post=${encodeURIComponent(postMatch[1])}` };

  if (rest === 'queue') return { workspaceId, to: '/queue' };
  if (rest === 'home' || rest === '') return { workspaceId, to: '/' };
  if (rest === 'settings/accounts') return { workspaceId, to: '/networks' };
  if (rest.startsWith('settings')) return { workspaceId, to: '/settings' };
  if (rest === 'approvals') return { workspaceId, to: '/approvals' };

  return { workspaceId, to: '/' };
}
