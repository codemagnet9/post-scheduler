// src/providers/types.ts
// The one interface every network implements, plus the capability descriptor both the composer's
// warnings and the publisher's checks read from. Nothing outside src/providers imports concrete
// adapters — only this file and registry.ts (enforced by the ESLint boundary in eslint.config.js).

export type ProviderKey = string; // 'bluesky', 'line', ...
export type MediaKind = 'image' | 'video' | 'gif';

export interface AspectRatio { w: number; h: number }

// How a network measures its text limit. These GENUINELY differ, and .length (UTF-16 units) is
// wrong for most non-Latin scripts and emoji. The validator measures in the declared unit.
export type TextUnit = 'graphemes' | 'code_points' | 'utf16_units' | 'bytes';

// What "publishing" actually produces on this network. Critical for setting customer expectations:
// a follower_broadcast or channel post is NOT publicly discoverable the way a feed post is.
export type PublicationSurface = 'public_feed' | 'follower_broadcast' | 'channel' | 'private';

// Rate limits differ wildly (per-account, per-app, points/quota). We model the common shape and
// leave exact numbers as configuration — a confident wrong rate limit costs a week (see brief).
export interface RateLimitShape {
  scope: 'account' | 'app';
  limit: number;
  windowSec: number;
  note?: string; // e.g. "points-based; approximate", "monthly quota, see plan"
}

// THE CAPABILITY DESCRIPTOR — single source of truth for validation and publishing.
export interface CapabilityDescriptor {
  provider: ProviderKey;
  displayName: string;
  publicationSurface: PublicationSurface;

  maxTextLength: number;
  textUnit: TextUnit;
  linksCountTowardText: boolean;

  acceptedMediaTypes: MediaKind[];
  minMediaCount: number;
  maxMediaCount: number;
  permittedAspectRatios: 'any' | AspectRatio[];
  aspectRatioTolerance: number; // fractional tolerance when permittedAspectRatios is a list

  maxVideoLengthSec?: number;
  maxVideoFileBytes?: number;
  maxImageFileBytes?: number;

  supportsFirstComment: boolean;
  threadSupport: 'none' | 'thread' | 'carousel';
  providerCanSchedule: boolean;

  mentionSyntax: string; // human description, e.g. '@handle'
  hashtagSyntax: string; // '#tag' or 'none'

  rateLimit: RateLimitShape;
  publishLeaseSeconds: number;    // per-provider publish lease (see 0002); slow-upload nets raise it
  publishTimeoutSeconds: number;  // ceiling on a single publish() call. MUST be < publishLeaseSeconds,
                                  // or the sweeper can fire mid-call and turn a success into needs_review.

  // The two flags that decide the ambiguous-failure path (see resolveAmbiguous in errors.ts).
  supportsIdempotencyKey: boolean;
  supportsRecentPostLookup: boolean;

  // Mirror the optional methods below so the registry can assert flag<->method consistency.
  supportsMetrics: boolean;
  supportsDelete: boolean;
  supportsRevoke: boolean;      // can we revoke the authorization at the provider on disconnect?
  supportsMediaUpload: boolean; // does the network need media pre-uploaded (e.g. Bluesky uploadBlob)?
}

// --- authorization: a discriminated union so both OAuth-redirect and credential-paste fit ---
export interface CredentialField { key: string; label: string; secret: boolean }
export type AuthStart =
  | { kind: 'oauth_redirect'; url: string; state: string; codeVerifier?: string }
  | { kind: 'credentials'; fields: CredentialField[] };

export interface AuthCallbackInput {
  code?: string;            // oauth_redirect
  state?: string;
  codeVerifier?: string;
  redirectUri?: string;
  fields?: Record<string, string>; // credentials
}

export interface Credentials {
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt?: Date;
  refreshExpiresAt?: Date;
  scopes?: string[];
  extra?: Record<string, unknown>; // provider-specific: did, pdsUrl, channelId, ...
}

export interface ConnectedAccountIdentity {
  providerAccountId: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface AuthResult { credentials: Credentials; account: ConnectedAccountIdentity }

// --- content & publishing ---
export interface RenderedMedia {
  kind: MediaKind;
  url: string; // a URL the adapter can fetch (public URL or signed storage URL)
  bytes?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  altText?: string;
  mimeType?: string;
}

export interface RenderedPost {
  text: string;
  link?: string;
  media: RenderedMedia[];
  firstComment?: string;
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string; // plain language, shown in the composer
}
export interface ValidationResult { ok: boolean; issues: ValidationIssue[] }

export interface AccountRef {
  providerAccountId: string;
  credentials: Credentials;
}

export interface PublishInput { account: AccountRef; post: RenderedPost }
export interface PublishResult { providerPostId: string; permalink?: string; raw?: unknown }

export interface MetricsResult {
  capturedAt: Date;
  // The COMMON shape (src/analytics/normalize.ts). A field the network does not supply is ABSENT
  // or null — never 0. Each adapter documents its own field mapping in its fetchMetrics.
  metrics: import('../analytics/normalize').NormalizedMetrics;
  raw?: unknown;
}

export interface RecentPost {
  providerPostId: string;
  createdAt?: Date;
  text?: string;
  fingerprint?: string; // adapter may precompute; publisher also derives from content
  raw?: unknown;
}
export interface RecentPostsQuery { account: AccountRef; since?: Date; limit?: number }

// THE ADAPTER INTERFACE. Optional methods are ABSENT (never throwing) when unsupported; the
// matching capability flag declares this, and the registry asserts they agree.
export interface ProviderAdapter {
  readonly key: ProviderKey;
  readonly capabilities: CapabilityDescriptor;

  beginAuthorization(params: { workspaceId: string; redirectUri: string; scopes?: string[] }): Promise<AuthStart>;
  exchangeCallback(input: AuthCallbackInput): Promise<AuthResult>;
  refreshCredentials(credentials: Credentials): Promise<Credentials>;

  validate(post: RenderedPost): ValidationResult;

  // Accepts a deterministic idempotency key; returns the provider's own post id.
  publish(input: PublishInput, opts: { idempotencyKey: string }): Promise<PublishResult>;

  // The reconciliation lookup: the only defence against double-posting on a lost response for the
  // many networks with no idempotency key. Present iff capabilities.supportsRecentPostLookup.
  recentPosts?(query: RecentPostsQuery): Promise<RecentPost[]>;

  fetchMetrics?(params: { providerPostId: string; account: AccountRef }): Promise<MetricsResult>;
  deletePost?(params: { providerPostId: string; account: AccountRef }): Promise<void>;

  // Best-effort revoke at the provider on disconnect. Present iff capabilities.supportsRevoke.
  revokeAuthorization?(params: { account: AccountRef }): Promise<void>;

  // Single-shot media pre-upload (e.g. Bluesky uploadBlob). Networks needing CHUNKED/resumable upload
  // for large video use the ProviderChunkBackend path (src/media/chunked-upload.ts) instead. Returns
  // an opaque provider reference to attach to the post.
  uploadMedia?(params: { account: AccountRef; bytes: Buffer; mimeType: string }): Promise<{ ref: unknown }>;
}
