// src/providers/adapters/line/index.ts
// REGIONAL adapter — LINE (Japan, Thailand, Taiwan). Uses the Messaging API broadcast, how a LINE
// Official Account publishes to its followers. Public and free: create an OA + Messaging API
// channel in the LINE Developers console, no partner approval.
//
// This adapter deliberately CONTRASTS with Bluesky to exercise the abstraction:
//  - It authorizes with a long-lived channel access token (no OAuth redirect, no user refresh).
//  - It DOES support an idempotency key: send endpoints accept the X-Line-Retry-Key header, and
//    LINE dedupes retries carrying the same key. So supportsIdempotencyKey = true.
//  - It does NOT support recent-post lookup (you cannot read back sent broadcasts) => false.
//    Consequence via resolveAmbiguous(): an ambiguous failure is safely RETRIED with the same
//    retry key rather than sent to a human. A network with NEITHER flag would go to needs_review.
//  - A broadcast is not an addressable post, so there is no delete and no per-post metrics —
//    both are declared false in capabilities rather than throwing at call time. providerPostId is
//    LINE's x-line-request-id (the only handle the API returns).
//
// Media must be public HTTPS URLs (LINE fetches them). Monthly send quota depends on the OA plan
// and is left as configuration, not asserted here.
import { NormalizedError, AmbiguousFailure } from '../../errors';
import { httpRequest, HttpTimeout } from '../../http';
import { validateAgainstCapabilities } from '../../validate';
import type {
  ProviderAdapter, CapabilityDescriptor, AuthResult, AuthStart, AuthCallbackInput, Credentials,
  PublishInput, PublishResult, RenderedMedia, AccountRef,
} from '../../types';

const API = 'https://api.line.me';

const capabilities: CapabilityDescriptor = {
  provider: 'line',
  displayName: 'LINE',
  publicationSurface: 'follower_broadcast', // OA message to followers, NOT a public feed post
  maxTextLength: 5000,
  textUnit: 'code_points', // LINE's limit is characters; exact unit unverified, code_points is safe
  linksCountTowardText: true,
  acceptedMediaTypes: ['image', 'video'],
  minMediaCount: 0,
  maxMediaCount: 4, // a broadcast carries up to 5 message objects; reserve 1 for text
  permittedAspectRatios: 'any',
  aspectRatioTolerance: 0.1,
  maxVideoLengthSec: 60,
  maxVideoFileBytes: 200 * 1024 * 1024,
  maxImageFileBytes: 10 * 1024 * 1024,
  supportsFirstComment: false,
  threadSupport: 'none',
  providerCanSchedule: false, // Messaging API broadcast is immediate
  mentionSyntax: 'none',
  hashtagSyntax: 'none',
  rateLimit: { scope: 'account', limit: 2000, windowSec: 1, note: 'req/sec high; monthly message quota is plan-based' },
  publishLeaseSeconds: 120,
  supportsIdempotencyKey: true,        // X-Line-Retry-Key
  supportsRecentPostLookup: false,     // cannot read back sent broadcasts
  supportsMetrics: false,
  supportsDelete: false,
  supportsRevoke: true,                // POST /v2/oauth/revoke (best-effort)
};

function toMessages(post: PublishInput['post']): unknown[] {
  const messages: unknown[] = [];
  if (post.text) messages.push({ type: 'text', text: post.text });
  for (const m of post.media as RenderedMedia[]) {
    if (m.kind === 'image') messages.push({ type: 'image', originalContentUrl: m.url, previewImageUrl: m.url });
    else if (m.kind === 'video') messages.push({ type: 'video', originalContentUrl: m.url, previewImageUrl: m.altText ?? m.url });
  }
  return messages.slice(0, 5);
}

function mapError(status: number, rawText: string): NormalizedError {
  if (status === 429) return new NormalizedError('rate_limited', 'LINE is rate-limiting us.', rawText);
  if (status === 401 || status === 403) return new NormalizedError('auth_expired', 'Your LINE channel token is invalid — reconnect the account.', rawText);
  if (status >= 500) return new NormalizedError('provider_unavailable', 'LINE is temporarily unavailable.', rawText);
  return new NormalizedError('content_rejected', 'LINE rejected this broadcast.', rawText);
}

export const lineAdapter: ProviderAdapter = {
  key: 'line',
  capabilities,

  async beginAuthorization(): Promise<AuthStart> {
    return {
      kind: 'credentials',
      fields: [{ key: 'channelAccessToken', label: 'Channel access token', secret: true }],
    };
  },

  async exchangeCallback(input: AuthCallbackInput): Promise<AuthResult> {
    const token = input.fields?.channelAccessToken;
    if (!token) throw new NormalizedError('content_rejected', 'Missing LINE channel access token.', input.fields);
    const res = await httpRequest(`${API}/v2/bot/info`, { headers: { authorization: `Bearer ${token}` }, timeoutMs: 15000 });
    if (!res.ok) throw new NormalizedError('auth_expired', 'That LINE channel access token was rejected.', res.text);
    const info = res.json<{ userId: string; basicId?: string; displayName?: string; pictureUrl?: string }>();
    return {
      credentials: { accessToken: token },
      account: { providerAccountId: info.basicId ?? info.userId, handle: info.basicId, displayName: info.displayName, avatarUrl: info.pictureUrl },
    };
  },

  async refreshCredentials(c: Credentials): Promise<Credentials> {
    // Long-lived channel tokens do not refresh in the basic model. Re-issuing via channel
    // id/secret (client_credentials) is a Phase 4 enhancement; here refresh is a no-op.
    return c;
  },

  validate(post) {
    return validateAgainstCapabilities(capabilities, post);
  },

  async publish(input: PublishInput, opts: { idempotencyKey: string }): Promise<PublishResult> {
    const res = await (async () => {
      try {
        return await httpRequest(`${API}/v2/bot/message/broadcast`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${input.account.credentials.accessToken}`,
            'content-type': 'application/json',
            'X-Line-Retry-Key': opts.idempotencyKey, // LINE dedupes retries with the same key
          },
          body: JSON.stringify({ messages: toMessages(input.post) }),
          timeoutMs: 20000,
        });
      } catch (e) {
        if (e instanceof HttpTimeout) throw new AmbiguousFailure({ endpoint: 'broadcast' });
        throw e;
      }
    })();
    if (!res.ok) throw mapError(res.status, res.text);
    // Broadcast returns no message id — the request id is the only handle we get.
    const requestId = res.headers.get('x-line-request-id') ?? `line-${opts.idempotencyKey}`;
    return { providerPostId: requestId };
  },

  async revokeAuthorization({ account }: { account: AccountRef }): Promise<void> {
    // Best-effort revoke of the channel access token.
    await httpRequest(`${API}/v2/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: account.credentials.accessToken }).toString(),
      timeoutMs: 10000,
    }).catch(() => undefined);
  },

  // No recentPosts / fetchMetrics / deletePost — declared unsupported in capabilities above.
};
