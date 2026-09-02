-- db/migrations/0007_phase6_publishing.sql
-- Publishing engine: optimistic version for compare-and-set, a dead-letter table, and a global
-- per-provider circuit breaker.

-- Optimistic-concurrency version on the hot target row. Every state transition bumps it; the
-- publish handler guards its writes with (state, version) so a duplicate job delivery no-ops.
ALTER TABLE post_targets ADD COLUMN version int NOT NULL DEFAULT 0;

-- The provider idempotency key is now STABLE per target (so providers that honour one dedupe across
-- retries and the ambiguous-retry path is safe). Drop the per-attempt uniqueness from Phase 3 —
-- job-redelivery safety comes from the (state, version) compare-and-set, not this constraint.
ALTER TABLE publish_attempts DROP CONSTRAINT IF EXISTS publish_attempts_idem_key;

-- Dead-letter: a target whose retryable attempts are exhausted, for operator inspection + requeue.
CREATE TABLE dead_letters (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  post_target_id uuid NOT NULL REFERENCES post_targets(id) ON DELETE CASCADE,
  reason         failure_code,
  error          jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  requeued_at    timestamptz,
  requeued_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT dead_letters_target_key UNIQUE (post_target_id)
);
CREATE INDEX dead_letters_ws_idx ON dead_letters (workspace_id, created_at DESC); -- serves: operator dead-letter view
ALTER TABLE dead_letters ENABLE ROW LEVEL SECURITY;
ALTER TABLE dead_letters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dead_letters
  USING      (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON dead_letters TO meridian_app;

-- Circuit breaker per provider. GLOBAL — a network being down affects every tenant — so no RLS.
CREATE TABLE provider_circuits (
  provider      text PRIMARY KEY,
  state         text NOT NULL DEFAULT 'closed',   -- closed | open | half_open
  failure_count int NOT NULL DEFAULT 0,
  opened_at     timestamptz,
  next_probe_at timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON provider_circuits TO meridian_app;
