// src/publishing/ratelimit.ts
// Per-provider-per-account publish budget, shared across workers via the Postgres fixed-window
// limiter. Ten workers publishing to one account respect one budget from capabilities.rateLimit.
import { consumeRateLimit, type RateLimitResult } from '../auth/rate-limit';
import type { CapabilityDescriptor } from '../providers/types';

export function providerRateLimit(provider: string, accountId: string, caps: CapabilityDescriptor): Promise<RateLimitResult> {
  return consumeRateLimit(`pub:${provider}:${accountId}`, caps.rateLimit.limit, caps.rateLimit.windowSec);
}
