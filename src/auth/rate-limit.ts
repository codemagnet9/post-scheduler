// src/auth/rate-limit.ts
import { sql } from 'drizzle-orm';
import { db } from '../db/index';

export interface RateLimitResult { allowed: boolean; remaining: number; retryAfterSec: number }

// Fixed-window counter kept in Postgres so it is correct across multiple app instances
// (no Redis in the MVP). The window bucket is computed server-side from now().
export async function consumeRateLimit(key: string, limit: number, windowSec: number): Promise<RateLimitResult> {
  const rows = (await db.execute(sql`
    insert into rate_limits (bucket_key, window_start, count)
    values (${key}, to_timestamp(floor(extract(epoch from now()) / ${windowSec}) * ${windowSec}), 1)
    on conflict (bucket_key, window_start) do update set count = rate_limits.count + 1
    returning count,
      extract(epoch from (window_start + make_interval(secs => ${windowSec}) - now()))::int as retry_after
  `)) as unknown as Array<{ count: number; retry_after: number }>;
  const { count, retry_after } = rows[0];
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSec: retry_after };
}

// The credential-endpoint limits, stated explicitly.
export const LIMITS = {
  login_ip:        { limit: 10, windowSec: 60 },   // 10 / min / IP
  login_account:   { limit: 5,  windowSec: 900 },  // 5 / 15 min / account
  signup_ip:       { limit: 5,  windowSec: 3600 }, // 5 / hour / IP
  reset_ip:        { limit: 5,  windowSec: 3600 }, // 5 / hour / IP
  reset_account:   { limit: 3,  windowSec: 3600 }, // 3 / hour / account
  verify_resend:   { limit: 3,  windowSec: 3600 }, // 3 / hour / account
  oauth_ip:        { limit: 20, windowSec: 60 },   // 20 / min / IP
  refresh_session: { limit: 60, windowSec: 60 },   // 60 / min / session
} as const;

export class RateLimitedError extends Error {
  constructor(public retryAfterSec: number) { super('rate_limited'); this.name = 'RateLimitedError'; }
}

export async function enforce(key: string, cfg: { limit: number; windowSec: number }): Promise<void> {
  const r = await consumeRateLimit(key, cfg.limit, cfg.windowSec);
  if (!r.allowed) throw new RateLimitedError(r.retryAfterSec);
}
