// src/providers/adapters/fake/index.ts
// Deterministic in-memory provider for tests. It can be told to fail in each taxonomy way, to be
// slow, to rate-limit, and — the mode the Phase 6 exactly-once tests depend on — to ACCEPT a
// publish (recording it so recentPosts can find it) and THEN throw a timeout.
import { createHash, randomBytes } from 'node:crypto';
import { NormalizedError, AmbiguousFailure, type FailureCode } from '../../errors';
import { validateAgainstCapabilities } from '../../validate';
import { contentFingerprint } from '../../fingerprint';
import type {
  ProviderAdapter, CapabilityDescriptor, AuthResult, AuthStart, PublishInput,
  PublishResult, RecentPost, RecentPostsQuery, MetricsResult, RenderedPost,
} from '../../types';

export type FakeMode =
  | { kind: 'ok' }
  | { kind: 'slow'; ms: number }
  | { kind: 'accept_then_timeout' } // records the post, then throws AmbiguousFailure
  | { kind: 'fail'; code: FailureCode; retryAfterSec?: number; reason?: string };

export interface FakeControl {
  mode: FakeMode;
  // Recorded posts per providerAccountId — what recentPosts() returns.
  store: Map<string, RecentPost[]>;
  publishCalls: number;
  lastAuthState?: string; // set on beginAuthorization when authKind === 'oauth_redirect'
}

export interface FakeConfig {
  key?: string;
  supportsRecentPostLookup?: boolean;
  supportsIdempotencyKey?: boolean;
  supportsMetrics?: boolean;
  supportsDelete?: boolean;
  supportsRevoke?: boolean;
  authKind?: 'credentials' | 'oauth_redirect';
  // Test hook: refreshCredentials behavior for the refresh-worker tests.
  refresh?: (c: import('../../types').Credentials) => Promise<import('../../types').Credentials>;
}

function deterministicId(idempotencyKey: string): string {
  return `fake-${createHash('sha1').update(idempotencyKey).digest('hex').slice(0, 12)}`;
}

export function createFakeProvider(config: FakeConfig = {}): { adapter: ProviderAdapter; control: FakeControl } {
  const key = config.key ?? 'fake';
  const supportsRecentPostLookup = config.supportsRecentPostLookup ?? true;
  const supportsIdempotencyKey = config.supportsIdempotencyKey ?? true;
  const supportsMetrics = config.supportsMetrics ?? true;
  const supportsDelete = config.supportsDelete ?? true;
  const supportsRevoke = config.supportsRevoke ?? true;

  const control: FakeControl = { mode: { kind: 'ok' }, store: new Map(), publishCalls: 0 };

  const capabilities: CapabilityDescriptor = {
    provider: key,
    displayName: 'Fake',
    publicationSurface: 'public_feed',
    maxTextLength: 1000,
    textUnit: 'utf16_units',
    linksCountTowardText: false,
    acceptedMediaTypes: ['image', 'video', 'gif'],
    minMediaCount: 0,
    maxMediaCount: 4,
    permittedAspectRatios: 'any',
    aspectRatioTolerance: 0.02,
    maxVideoLengthSec: 600,
    supportsFirstComment: true,
    threadSupport: 'thread',
    providerCanSchedule: false,
    mentionSyntax: '@handle',
    hashtagSyntax: '#tag',
    rateLimit: { scope: 'account', limit: 1000, windowSec: 3600 },
    publishLeaseSeconds: 60,
    supportsIdempotencyKey,
    supportsRecentPostLookup,
    supportsMetrics,
    supportsDelete,
    supportsRevoke,
  };

  function record(accountId: string, post: RenderedPost, providerPostId: string): void {
    const list = control.store.get(accountId) ?? [];
    list.unshift({
      providerPostId,
      createdAt: new Date(),
      text: post.text,
      fingerprint: contentFingerprint(post),
    });
    control.store.set(accountId, list);
  }

  const adapter: ProviderAdapter = {
    key,
    capabilities,

    async beginAuthorization(): Promise<AuthStart> {
      if (config.authKind === 'oauth_redirect') {
        const state = randomBytes(16).toString('hex');
        control.lastAuthState = state;
        return { kind: 'oauth_redirect', url: `https://fake.test/oauth?state=${state}`, state, codeVerifier: 'verifier' };
      }
      return { kind: 'credentials', fields: [{ key: 'token', label: 'Token', secret: true }] };
    },
    async exchangeCallback(input): Promise<AuthResult> {
      // Echo a submitted token so tests can assert it never reaches the logs.
      const accessToken = input.fields?.token ?? 'fake-access-token';
      return { credentials: { accessToken, refreshToken: 'fake-refresh-token' }, account: { providerAccountId: 'fake-account', handle: 'fake' } };
    },
    async refreshCredentials(c) {
      return config.refresh ? config.refresh(c) : c;
    },

    validate(post) {
      return validateAgainstCapabilities(capabilities, post);
    },

    async publish(input: PublishInput, opts: { idempotencyKey: string }): Promise<PublishResult> {
      control.publishCalls += 1;
      const id = deterministicId(opts.idempotencyKey);
      const mode = control.mode;
      switch (mode.kind) {
        case 'ok':
          record(input.account.providerAccountId, input.post, id);
          return { providerPostId: id, permalink: `https://fake.test/p/${id}` };
        case 'slow':
          await new Promise((r) => setTimeout(r, mode.ms));
          record(input.account.providerAccountId, input.post, id);
          return { providerPostId: id, permalink: `https://fake.test/p/${id}` };
        case 'accept_then_timeout':
          // The provider actually created the post... but the response was lost.
          record(input.account.providerAccountId, input.post, id);
          throw new AmbiguousFailure({ mode: 'accept_then_timeout' });
        case 'fail':
          throw new NormalizedError(mode.code, mode.reason ?? `fake ${mode.code}`, { mode }, mode.retryAfterSec);
      }
    },

    ...(supportsRecentPostLookup
      ? {
          async recentPosts(query: RecentPostsQuery): Promise<RecentPost[]> {
            return (control.store.get(query.account.providerAccountId) ?? []).slice(0, query.limit ?? 20);
          },
        }
      : {}),

    ...(supportsMetrics
      ? {
          async fetchMetrics(): Promise<MetricsResult> {
            return { capturedAt: new Date(), metrics: { impressions: 100, likes: 10, comments: 2, shares: 1 } };
          },
        }
      : {}),

    ...(supportsDelete
      ? {
          async deletePost({ providerPostId, account }): Promise<void> {
            const list = control.store.get(account.providerAccountId) ?? [];
            control.store.set(account.providerAccountId, list.filter((p) => p.providerPostId !== providerPostId));
          },
        }
      : {}),

    ...(supportsRevoke
      ? {
          async revokeAuthorization(): Promise<void> {
            /* no-op for the fake */
          },
        }
      : {}),
  };

  return { adapter, control };
}

// A default instance for registration in test environments.
export const fakeAdapter = (): ProviderAdapter => createFakeProvider().adapter;
