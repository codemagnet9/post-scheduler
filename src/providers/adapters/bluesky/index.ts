// src/providers/adapters/bluesky/index.ts
// GLOBAL adapter — Bluesky / AT Protocol. Public, no partner approval. App-password auth; publish
// via createRecord with a deterministic rkey (idempotent); recentPosts + metrics + delete supported.
//
// Success is decided from the RESPONSE BODY, never from the HTTP status alone (see http.ts): a body
// carrying an `error` field is a failure even on a 2xx.
import { NormalizedError, AmbiguousFailure } from '../../errors';
import { httpRequest, parseJson, HttpTimeout } from '../../http';
import { validateAgainstCapabilities } from '../../validate';
import { contentFingerprint } from '../../fingerprint';
import type {
  ProviderAdapter, CapabilityDescriptor, AuthResult, AuthStart, AuthCallbackInput, Credentials,
  PublishInput, PublishResult, RecentPost, RecentPostsQuery, MetricsResult, AccountRef,
} from '../../types';

const DEFAULT_PDS = 'https://bsky.social';
const READ_TIMEOUT_MS = 15000;
const PUBLISH_TIMEOUT_SEC = 15;

const capabilities: CapabilityDescriptor = {
  provider: 'bluesky',
  displayName: 'Bluesky',
  publicationSurface: 'public_feed',
  maxTextLength: 300,
  textUnit: 'graphemes',
  linksCountTowardText: true,
  acceptedMediaTypes: ['image', 'video'],
  minMediaCount: 0,
  maxMediaCount: 4,
  permittedAspectRatios: 'any',
  aspectRatioTolerance: 0.05,
  maxVideoLengthSec: 60,
  maxVideoFileBytes: 50 * 1024 * 1024,
  maxImageFileBytes: 1024 * 1024,
  supportsFirstComment: false,
  threadSupport: 'thread',
  providerCanSchedule: false,
  mentionSyntax: '@handle.bsky.social',
  hashtagSyntax: '#tag',
  rateLimit: { scope: 'account', limit: 5000, windowSec: 3600, note: 'points-based; approximate' },
  publishLeaseSeconds: 60,
  publishTimeoutSeconds: PUBLISH_TIMEOUT_SEC, // 15 < 60
  supportsIdempotencyKey: true,
  supportsRecentPostLookup: true,
  supportsMetrics: true,
  supportsDelete: true,
  supportsRevoke: true,
};

function pds(c: Credentials): string {
  return (c.extra?.pdsUrl as string) ?? DEFAULT_PDS;
}
function rkeyFromIdempotencyKey(idempotencyKey: string): string {
  return idempotencyKey.replace(/[^a-zA-Z0-9._~-]/g, '').slice(0, 40) || 'post';
}

function mapError(status: number, error: string | undefined, rawText: string): NormalizedError {
  if (status === 429) return new NormalizedError('rate_limited', 'Bluesky is rate-limiting us.', rawText);
  if (status === 401 || error === 'ExpiredToken' || error === 'InvalidToken')
    return new NormalizedError('auth_expired', 'Your Bluesky connection expired.', rawText);
  if (status >= 500) return new NormalizedError('provider_unavailable', 'Bluesky is temporarily unavailable.', rawText);
  if (error === 'BlobTooLarge' || error === 'InvalidMimeType')
    return new NormalizedError('invalid_media', 'Bluesky rejected the media.', rawText);
  return new NormalizedError('content_rejected', 'Bluesky rejected this post.', rawText);
}

async function xrpc<T>(c: Credentials, method: 'GET' | 'POST', nsid: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const res = await httpRequest(`${pds(c)}/xrpc/${nsid}${qs}`, {
    method,
    headers: { authorization: `Bearer ${c.accessToken}`, 'content-type': 'application/json' },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
    timeoutMs: READ_TIMEOUT_MS,
  });
  const parsed = parseJson<{ error?: string }>(res.text);
  if (parsed?.error) throw mapError(res.status, parsed.error, res.text); // body error wins, even on 2xx
  if (res.status < 200 || res.status >= 300) throw mapError(res.status, undefined, res.text);
  return (parsed ?? {}) as T;
}

export const blueskyAdapter: ProviderAdapter = {
  key: 'bluesky',
  capabilities,

  async beginAuthorization(): Promise<AuthStart> {
    return {
      kind: 'credentials',
      fields: [
        { key: 'identifier', label: 'Handle or email', secret: false },
        { key: 'appPassword', label: 'App password', secret: true },
      ],
    };
  },

  async exchangeCallback(input: AuthCallbackInput): Promise<AuthResult> {
    const identifier = input.fields?.identifier;
    const appPassword = input.fields?.appPassword;
    if (!identifier || !appPassword) throw new NormalizedError('content_rejected', 'Missing Bluesky credentials.', input.fields);
    const res = await httpRequest(`${DEFAULT_PDS}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, password: appPassword }),
      timeoutMs: READ_TIMEOUT_MS,
    });
    const s = parseJson<{ accessJwt?: string; refreshJwt?: string; did?: string; handle?: string; error?: string }>(res.text);
    if (s?.error || res.status < 200 || res.status >= 300 || !s?.accessJwt || !s.did) {
      throw new NormalizedError('auth_expired', 'Bluesky sign-in failed — check the handle and app password.', res.text);
    }
    return {
      credentials: { accessToken: s.accessJwt, refreshToken: s.refreshJwt, extra: { did: s.did, pdsUrl: DEFAULT_PDS } },
      account: { providerAccountId: s.did, handle: s.handle, displayName: s.handle },
    };
  },

  async refreshCredentials(c: Credentials): Promise<Credentials> {
    const res = await httpRequest(`${pds(c)}/xrpc/com.atproto.server.refreshSession`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.refreshToken}` },
      timeoutMs: READ_TIMEOUT_MS,
    });
    const s = parseJson<{ accessJwt?: string; refreshJwt?: string; error?: string }>(res.text);
    if (s?.error || res.status < 200 || res.status >= 300 || !s?.accessJwt) {
      throw new NormalizedError('auth_expired', 'Your Bluesky connection expired — reconnect the account.', res.text);
    }
    return { ...c, accessToken: s.accessJwt, refreshToken: s.refreshJwt };
  },

  validate(post) {
    return validateAgainstCapabilities(capabilities, post);
  },

  async publish(input: PublishInput, opts: { idempotencyKey: string }): Promise<PublishResult> {
    const c = input.account.credentials;
    const did = (c.extra?.did as string) ?? input.account.providerAccountId;
    const rkey = rkeyFromIdempotencyKey(opts.idempotencyKey);
    const record = { $type: 'app.bsky.feed.post', text: input.post.text, createdAt: new Date().toISOString() };

    let res;
    try {
      res = await httpRequest(`${pds(c)}/xrpc/com.atproto.repo.createRecord`, {
        method: 'POST',
        headers: { authorization: `Bearer ${c.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', rkey, record }),
        timeoutMs: PUBLISH_TIMEOUT_SEC * 1000,
      });
    } catch (e) {
      if (e instanceof HttpTimeout) throw new AmbiguousFailure({ url: 'createRecord', rkey });
      throw e;
    }

    const parsed = parseJson<{ uri?: string; error?: string }>(res.text);
    if (parsed?.error) {
      // Deterministic rkey: an already-successful attempt surfaces as a duplicate — treat as success.
      if (/RecordAlreadyExists|could not/i.test(parsed.error)) {
        return { providerPostId: rkey, permalink: `https://bsky.app/profile/${did}/post/${rkey}` };
      }
      throw mapError(res.status, parsed.error, res.text);
    }
    if (res.status < 200 || res.status >= 300) throw mapError(res.status, undefined, res.text);
    if (!parsed?.uri) throw new NormalizedError('permanent_failure', 'Bluesky accepted the request but returned no post reference.', res.text);
    return { providerPostId: rkey, permalink: `https://bsky.app/profile/${did}/post/${rkey}`, raw: parsed };
  },

  async recentPosts(query: RecentPostsQuery): Promise<RecentPost[]> {
    const c = query.account.credentials;
    const did = (c.extra?.did as string) ?? query.account.providerAccountId;
    const out = await xrpc<{ records: Array<{ uri: string; value: { text?: string; createdAt?: string } }> }>(
      c, 'GET', 'com.atproto.repo.listRecords', undefined,
      { repo: did, collection: 'app.bsky.feed.post', limit: String(query.limit ?? 20) },
    );
    return (out.records ?? []).map((r) => {
      const rkey = r.uri.split('/').pop() ?? r.uri;
      const text = r.value.text ?? '';
      return { providerPostId: rkey, createdAt: r.value.createdAt ? new Date(r.value.createdAt) : undefined, text, fingerprint: contentFingerprint({ text, media: [] }) };
    });
  },

  async fetchMetrics({ providerPostId, account }: { providerPostId: string; account: AccountRef }): Promise<MetricsResult> {
    const c = account.credentials;
    const did = (c.extra?.did as string) ?? account.providerAccountId;
    const uri = `at://${did}/app.bsky.feed.post/${providerPostId}`;
    const out = await xrpc<{ posts: Array<{ likeCount?: number; repostCount?: number; replyCount?: number }> }>(
      c, 'GET', 'app.bsky.feed.getPosts', undefined, { uris: uri },
    );
    const p = out.posts?.[0] ?? {};
    return { capturedAt: new Date(), metrics: { likes: p.likeCount ?? 0, shares: p.repostCount ?? 0, comments: p.replyCount ?? 0 }, raw: out };
  },

  async deletePost({ providerPostId, account }: { providerPostId: string; account: AccountRef }): Promise<void> {
    const c = account.credentials;
    const did = (c.extra?.did as string) ?? account.providerAccountId;
    await xrpc(c, 'POST', 'com.atproto.repo.deleteRecord', { repo: did, collection: 'app.bsky.feed.post', rkey: providerPostId });
  },

  async revokeAuthorization({ account }: { account: AccountRef }): Promise<void> {
    const c = account.credentials;
    await httpRequest(`${pds(c)}/xrpc/com.atproto.server.deleteSession`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.refreshToken ?? c.accessToken}` },
      timeoutMs: 10000,
    }).catch(() => undefined);
  },

  // uploadBlob: single POST of the raw bytes; returns a blob ref to embed in the post record (used
  // for images and short video). This is the Phase 3 TODO, now implemented.
  async uploadMedia({ account, bytes, mimeType }: { account: AccountRef; bytes: Buffer; mimeType: string }): Promise<{ ref: unknown }> {
    const c = account.credentials;
    let res;
    try {
      res = await httpRequest(`${pds(c)}/xrpc/com.atproto.repo.uploadBlob`, {
        method: 'POST',
        headers: { authorization: `Bearer ${c.accessToken}`, 'content-type': mimeType },
        body: bytes,
        timeoutMs: PUBLISH_TIMEOUT_SEC * 1000,
      });
    } catch (e) {
      if (e instanceof HttpTimeout) throw new AmbiguousFailure({ url: 'uploadBlob' });
      throw e;
    }
    const parsed = parseJson<{ blob?: unknown; error?: string }>(res.text);
    if (parsed?.error) throw mapError(res.status, parsed.error, res.text);
    if (res.status < 200 || res.status >= 300 || !parsed?.blob) {
      throw new NormalizedError('invalid_media', 'Bluesky rejected the media upload.', res.text);
    }
    return { ref: parsed.blob };
  },
};
