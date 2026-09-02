// src/providers/errors.ts
// One normalized taxonomy across every provider. Retry policy keys off the CODE, never a raw
// message string. Adapters translate their own failures into these; nothing else parses provider
// responses.

import type { CapabilityDescriptor } from './types';

export type FailureCode =
  | 'rate_limited'
  | 'auth_expired'
  | 'invalid_media'
  | 'content_rejected'
  | 'duplicate_content'
  | 'provider_unavailable'
  | 'permanent_failure';

// A classified provider failure. plainMessage is what a non-technical user reads on the failed
// banner; providerRaw is kept for the log. Never show providerRaw to the user.
export class NormalizedError extends Error {
  constructor(
    public code: FailureCode,
    public plainMessage: string,
    public providerRaw: unknown,
    public retryAfterSec?: number,
    // Set to true ONLY when the adapter matched an explicit, documented revocation signal from the
    // provider. Never inferred from an error string. Drives the fail-safe classification in
    // accounts/refresh.ts — when false/absent, a refresh failure is auth_expired, not revoked.
    public revoked: boolean = false,
  ) {
    super(plainMessage);
    this.name = 'NormalizedError';
  }
}

// A publish request that was SENT but whose outcome is unknown (timeout / dropped connection with
// no confirmation). This is NOT a taxonomy code — it must never be blindly retried. The publisher
// routes it through resolveAmbiguous() below.
export class AmbiguousFailure extends Error {
  constructor(public providerRaw: unknown, message = 'ambiguous: publish sent, no confirmation received') {
    super(message);
    this.name = 'AmbiguousFailure';
  }
}

export interface RetryRule {
  retryable: boolean;
  backoff: 'none' | 'fixed' | 'exponential' | 'provider_hint';
  maxAttempts: number;
  userTemplate: string; // {network} and {reason} are substituted
}

// THE RETRY POLICY, as data. See the table in the phase notes for the same content.
export const RETRY_POLICY: Record<FailureCode, RetryRule> = {
  rate_limited:         { retryable: true,  backoff: 'provider_hint', maxAttempts: 5, userTemplate: '{network} is rate-limiting us — we’ll retry automatically.' },
  provider_unavailable: { retryable: true,  backoff: 'exponential',   maxAttempts: 6, userTemplate: '{network} is temporarily unavailable — retrying.' },
  auth_expired:         { retryable: true,  backoff: 'none',          maxAttempts: 2, userTemplate: 'Your {network} connection expired — reconnect the account to publish.' },
  invalid_media:        { retryable: false, backoff: 'none',          maxAttempts: 1, userTemplate: '{network} rejected the media: {reason}. Replace it and retry.' },
  content_rejected:     { retryable: false, backoff: 'none',          maxAttempts: 1, userTemplate: '{network} rejected this post: {reason}.' },
  duplicate_content:    { retryable: false, backoff: 'none',          maxAttempts: 1, userTemplate: '{network} flagged this as a duplicate of a recent post.' },
  permanent_failure:    { retryable: false, backoff: 'none',          maxAttempts: 1, userTemplate: 'Publishing to {network} failed: {reason}.' },
};

const BASE_BACKOFF_SEC = 15;

export function nextBackoffSeconds(code: FailureCode, attempt: number, retryAfterSec?: number): number {
  const rule = RETRY_POLICY[code];
  switch (rule.backoff) {
    case 'provider_hint':
      return retryAfterSec ?? BASE_BACKOFF_SEC * 2 ** (attempt - 1);
    case 'exponential':
      return Math.min(BASE_BACKOFF_SEC * 2 ** (attempt - 1), 3600);
    case 'fixed':
      return BASE_BACKOFF_SEC;
    case 'none':
    default:
      return 0;
  }
}

export function userMessage(code: FailureCode, network: string, reason = ''): string {
  return RETRY_POLICY[code].userTemplate.replace('{network}', network).replace('{reason}', reason).trim();
}

// The exactly-once decision for an AmbiguousFailure, driven entirely by capabilities:
//   - can look up recent posts -> reconcile (adopt the created post's id, or safely retry)
//   - else has an idempotency key -> retry with the SAME key; the provider dedupes
//   - else -> a human must decide (needs_review); we must not auto-retry
export type AmbiguousResolution = 'lookup' | 'retry_idempotent' | 'needs_review';

export function resolveAmbiguous(caps: CapabilityDescriptor): AmbiguousResolution {
  if (caps.supportsRecentPostLookup) return 'lookup';
  if (caps.supportsIdempotencyKey) return 'retry_idempotent';
  return 'needs_review';
}
