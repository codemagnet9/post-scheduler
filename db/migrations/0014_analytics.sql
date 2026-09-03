-- db/migrations/0014_analytics.sql
-- Immutable metric snapshots (normalized columns + raw), the per-target ingestion cursor, and the
-- CSV export job table.

-- Normalized metric columns on the (already immutable, unique per (target, captured_at)) snapshot.
-- NULL = the network does not supply this field. NEVER 0. A real 0 is stored as 0.
ALTER TABLE metric_snapshots
  ADD COLUMN impressions bigint,
  ADD COLUMN reach       bigint,
  ADD COLUMN engagements bigint,
  ADD COLUMN clicks      bigint,
  ADD COLUMN saves       bigint,
  ADD COLUMN shares      bigint,
  ADD COLUMN raw         jsonb;

-- Read models group by network; the account carries the provider. (workspace_id, captured_at) is
-- already indexed by metric_snapshots_ws_time_idx (schema.sql); add the account+time index for the
-- "latest snapshot per account" DISTINCT ON.
CREATE INDEX metric_snapshots_account_captured_idx ON metric_snapshots (connected_account_id, captured_at DESC);

-- Ingestion cursor: the next time a snapshot is due for this target. Set on publish (to +1h) for
-- metrics-capable networks, advanced by the snapshot worker (1h -> 24h -> 7d -> weekly, then null at
-- ~90 days). NULL = nothing scheduled (network has no metrics, or the post aged out).
ALTER TABLE post_targets ADD COLUMN metrics_next_at timestamptz;
-- The metrics due-scan: partial on "has a pending snapshot", so it stays tiny (mirror of the publish scan).
CREATE INDEX post_targets_metrics_due_idx ON post_targets (metrics_next_at) WHERE metrics_next_at IS NOT NULL;

-- CSV export jobs. Generated in the background; the API hands back a signed link when status='ready'.
CREATE TABLE analytics_exports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  date_from    date NOT NULL,
  date_to      date NOT NULL,
  status       text NOT NULL DEFAULT 'pending', -- pending | ready | failed
  storage_key  text,
  row_count    int,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX analytics_exports_ws_idx ON analytics_exports (workspace_id, created_at DESC);
CREATE INDEX analytics_exports_pending_idx ON analytics_exports (created_at) WHERE status = 'pending';
ALTER TABLE analytics_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON analytics_exports
  USING      (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON analytics_exports TO meridian_app;
