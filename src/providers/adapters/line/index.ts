// src/providers/adapters/line/index.ts
// REGIONAL adapter — LINE (Japan, Thailand, Taiwan) Messaging API broadcast. Public, no partner
// approval. Long-lived channel-token auth; idempotency via X-Line-Retry-Key; NO recent-post lookup.
//
// Success is decided from the BODY: LINE returns { message, details } on error, and some LINE
// endpoints surface errors with a 200. A body carrying `message` is a failure regardless of status.
import { NormalizedError, AmbiguousFailure } from '../../errors';
import { httpRequest, parseJson, HttpTimeout } from '../../http';
import { validateAgainstCapabilities } from '../../validate';
import type {
  ProviderAdapter, CapabilityDescriptor, AuthResult, AuthStart, AuthCallbackInput, Credentials,
  PublishInput, PublishResult, RenderedMedia, AccountRef,
} from '../../types';

const API = 'https://api.line.me';
const READ_TIMEOUT_MS = 15000;
const PUBLISH_TIMEOUT_SEC = 20;

const capabilities: CapabilityDescriptor = {
  provider: 'line',
  displayName: 'LINE',
  publicationSurface: 'follower_broadcast',
  maxTextLength: 5000,
  textUnit: 'code_points',
  linksCountTowardText: true,
  acceptedMediaTypes: ['image', 'video'],
  minMediaCount: 0,
  maxMediaCount: 4,
  permittedAspectRatios: 'any',
  aspectRatioTolerance: 0.1,
  maxVideoLengthSec: 60,
  maxVideoFileBytes: 200 * 1024 * 1024,
  maxImageFileBytes: 10 * 1024 * 1024,
  supportsFirstComment: false,
  threadSupport: 'none',
  providerCanSchedule: false,
  mentionSyntax: 'none',
  hashtagSyntax: 'none',
  rateLimit: { scope: 'account', limit: 2000, windowSec: 1, note: 'req/sec high; monthly message quota is plan-based' },
  publishLeaseSeconds: 120,
  publishTimeoutSeconds: PUBLISH_TIMEOUT_SEC, // 20 < 120
  supportsIdempotencyKey: true,
  supportsRecentPostLookup: false,
  supportsMetrics: false,
  supportsDelete: false,
  supportsRevoke: true,
  supportsMediaUpload: false, // media referenced by public HTTPS URL, no pre-upload step
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
    return { kind: 'credentials', fields: [{ key: 'channelAccessToken', label: 'Channel access token', secret: true }] };
  },

  async exchangeCallback(input: AuthCallbackInput): Promise<AuthResult> {
    const token = input.fields?.channelAccessToken;
    if (!token) throw new NormalizedError('content_rejected', 'Missing LINE channel access token.', input.fields);
    const res = await httpRequest(`${API}/v2/bot/info`, { headers: { authorization: `Bearer ${token}` }, timeoutMs: READ_TIMEOUT_MS });
    const info = parseJson<{ userId?: string; basicId?: string; displayName?: string; pictureUrl?: string; message?: string }>(res.text);
    if (info?.message || res.status < 200 || res.status >= 300 || !info?.userId) {
      throw new NormalizedError('auth_expired', 'That LINE channel access token was rejected.', res.text);
    }
    return {
      credentials: { accessToken: token },
      account: { providerAccountId: info.basicId ?? info.userId, handle: info.basicId, displayName: info.displayName, avatarUrl: info.pictureUrl },
    };
  },

  async refreshCredentials(c: Credentials): Promise<Credentials> {
    return c; // long-lived channel token; re-issuance via channel id/secret is a later enhancement
  },

  validate(post) {
    return validateAgainstCapabilities(capabilities, post);
  },

  async publish(input: PublishInput, opts: { idempotencyKey: string }): Promise<PublishResult> {
    let res;
    try {
      res = await httpRequest(`${API}/v2/bot/message/broadcast`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.account.credentials.accessToken}`,
          'content-type': 'application/json',
          'X-Line-Retry-Key': opts.idempotencyKey,
        },
        body: JSON.stringify({ messages: toMessages(input.post) }),
        timeoutMs: PUBLISH_TIMEOUT_SEC * 1000,
      });
    } catch (e) {
      if (e instanceof HttpTimeout) throw new AmbiguousFailure({ endpoint: 'broadcast' });
      throw e;
    }
    // Body-first classification: an error `message` is a failure even if the status was 200.
    const parsed = parseJson<{ message?: string }>(res.text);
    if (parsed?.message) throw mapError(res.status, res.text);
    if (res.status < 200 || res.status >= 300) throw mapError(res.status, res.text);
    const requestId = res.headers.get('x-line-request-id') ?? `line-${opts.idempotencyKey}`;
    return { providerPostId: requestId };
  },

  async revokeAuthorization({ account }: { account: AccountRef }): Promise<void> {
    await httpRequest(`${API}/v2/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: account.credentials.accessToken }).toString(),
      timeoutMs: 10000,
    }).catch(() => undefined);
  },
};
