-- db/migrations/0015_public_api.sql
-- Public API + webhooks: per-key rate limit + usage counter on api_keys, and the "why we disabled
-- you" fields on webhook_endpoints. The tables themselves (api_keys, api_idempotency_keys, events,
-- webhook_endpoints, webhook_deliveries) already exist from Phase 1 with tenant RLS (0004).

-- Per-key throttle (requests/minute, its own bucket) and a lifetime usage counter, plus last_used_at
-- which already exists on api_keys.
ALTER TABLE api_keys ADD COLUMN rate_limit_per_min int    NOT NULL DEFAULT 120;
ALTER TABLE api_keys ADD COLUMN request_count      bigint NOT NULL DEFAULT 0;

-- When we auto-disable a webhook that has been failing too long, record WHY so the customer sees it.
ALTER TABLE webhook_endpoints ADD COLUMN disabled_reason text;
ALTER TABLE webhook_endpoints ADD COLUMN disabled_at     timestamptz;

-- Expired idempotency records are garbage-collected by a cron; index the expiry for the sweep.
CREATE INDEX IF NOT EXISTS api_idempotency_expiry_idx ON api_idempotency_keys (expires_at);
