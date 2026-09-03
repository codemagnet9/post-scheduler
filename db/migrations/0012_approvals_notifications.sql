-- db/migrations/0012_approvals_notifications.sql
-- Approvals (incl. two-approver paid promotions), comment mentions, and the notification system
-- (preferences matrix + in-app notifications with a dedupe key).

ALTER TABLE posts      ADD COLUMN is_paid_promotion boolean NOT NULL DEFAULT false;
ALTER TABLE comments   ADD COLUMN mentions jsonb NOT NULL DEFAULT '[]';       -- workspace member ids
ALTER TABLE workspaces ADD COLUMN slack_webhook_url text;                     -- workspace Slack channel

-- Notifications consume the event outbox on their OWN cursor, separate from the webhook fan-out flag
-- (Phase 10), so the two consumers never starve each other.
ALTER TABLE events ADD COLUMN notified_at timestamptz;
CREATE INDEX events_notify_idx ON events (occurred_at) WHERE notified_at IS NULL;

-- One decision row per approver per post; a paid promotion needs two DISTINCT approvers.
CREATE TABLE approval_decisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id      uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  approver_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  decision     text NOT NULL,   -- 'approved'
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_decisions_post_approver_key UNIQUE (post_id, approver_id)
);
CREATE INDEX approval_decisions_post_idx ON approval_decisions (post_id);
ALTER TABLE approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON approval_decisions
  USING      (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_decisions TO meridian_app;

-- Per-user, per-event, per-channel preference. Absent row => a coded default (preferences.ts).
CREATE TABLE notification_preferences (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type   text NOT NULL,
  channel      text NOT NULL,  -- 'in_app' | 'email' | 'slack'
  enabled      boolean NOT NULL,
  CONSTRAINT notification_preferences_key UNIQUE (workspace_id, user_id, event_type, channel)
);
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;
-- The dispatcher (system context) reads workspace members' prefs; a user only writes their own.
CREATE POLICY np_read ON notification_preferences FOR SELECT
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY np_write ON notification_preferences FOR ALL
  USING      (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_preferences TO meridian_app;

-- In-app notifications AND the delivery/dedupe record. `channels` = channels actually delivered;
-- the in-app list filters to rows where 'in_app' is in channels. dedupe_key makes repeat signals
-- (e.g. many failures against one account) collapse to ONE alert.
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type   text NOT NULL,
  title        text NOT NULL,
  body         text,
  deep_link    text,
  channels     text[] NOT NULL DEFAULT '{}',
  dedupe_key   text,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notifications_dedupe_idx ON notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_user_idx ON notifications (workspace_id, user_id, created_at DESC);
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY notif_read ON notifications FOR SELECT
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY notif_insert ON notifications FOR INSERT
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid); -- dispatcher inserts for any member
CREATE POLICY notif_update ON notifications FOR UPDATE
  USING      (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid AND user_id = nullif(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO meridian_app;
