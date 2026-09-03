// src/analytics/ratelimit.ts
// The analytics ingestion budget. It is a SEPARATE fixed-window bucket from the publish budget
// (`pub:*`), so a burst of metric pulls can NEVER consume the tokens publishing needs — analytics
// must never starve the publish queue. We cap it at a fraction of the provider's published limit so
// we also stay within the provider's real ceiling.
import { consumeRateLimit, type RateLimitResult } from '../auth/rate-limit';
import type { CapabilityDescriptor } from '../providers/types';

// Analytics gets at most this share of a provider's account rate limit, in its own bucket.
const METRICS_BUDGET_FRACTION = 0.1;

export function metricsRateLimit(provider: string, accountId: string, caps: CapabilityDescriptor): Promise<RateLimitResult> {
  const limit = Math.max(1, Math.floor(caps.rateLimit.limit * METRICS_BUDGET_FRACTION));
  return consumeRateLimit(`metrics:${provider}:${accountId}`, limit, caps.rateLimit.windowSec);
}
