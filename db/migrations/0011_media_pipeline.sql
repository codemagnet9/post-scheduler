-- db/migrations/0011_media_pipeline.sql
-- Probe fields on media_assets, and a resumable provider-upload session table so a large video that
-- fails at 90% resumes from its last committed offset instead of restarting the whole publish.

ALTER TABLE media_assets
  ADD COLUMN codec      text,
  ADD COLUMN frame_rate numeric;

-- One row per (target, source object) provider upload in flight. bytes_uploaded is the resume point.
CREATE TABLE media_upload_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  post_target_id   uuid NOT NULL REFERENCES post_targets(id) ON DELETE CASCADE,
  provider         text NOT NULL,
  storage_key      text NOT NULL,           -- the source (variant) object being uploaded
  provider_upload_id text,                  -- the provider's resumable session id
  total_bytes      bigint NOT NULL,
  bytes_uploaded   bigint NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'in_progress', -- in_progress | finalizing | completed | failed
  provider_ref     text,                    -- the finalized blob/media ref to attach to the post
  last_error       jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_upload_sessions_target_key UNIQUE (post_target_id, storage_key) -- serves: resume lookup
);
CREATE INDEX media_upload_sessions_ws_idx ON media_upload_sessions (workspace_id);

ALTER TABLE media_upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_upload_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON media_upload_sessions
  USING      (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON media_upload_sessions TO meridian_app;
