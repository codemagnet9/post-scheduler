-- db/migrations/0006_phase4_oauth.sql
-- OAuth connect state, account-health columns, and two new account statuses.

-- New health statuses. (auth_expired already means "reauthorization required".)
ALTER TYPE account_status ADD VALUE IF NOT EXISTS 'revoked';    -- user revoked at the provider
ALTER TYPE account_status ADD VALUE IF NOT EXISTS 'suspended';  -- provider suspended the account

-- Notify-once bookkeeping: which bad status we last told the workspace about.
ALTER TABLE connected_accounts
  ADD COLUMN health_notified_status text,
  ADD COLUMN health_notified_at     timestamptz;

-- Single-use, expiring, tenant+user-bound OAuth state (with PKCE verifier). A callback that cannot
-- match an unconsumed, unexpired row for the SAME user is rejected — kills replay and cross-tenant
-- attach. We store the hash of the state, never the raw value.
CREATE TABLE oauth_states (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash    text NOT NULL,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  code_verifier text,               -- PKCE; short-lived, single-use
  redirect_uri  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  CONSTRAINT oauth_states_hash_key UNIQUE (state_hash)  -- serves: callback lookup
);
CREATE INDEX oauth_states_expiry_idx ON oauth_states (expires_at); -- serves: sweep expired states

-- RLS: created within a workspace context; read/consumed at the callback under the user's context
-- (no workspace yet), so the user may always see their own state rows.
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY oauth_states_rw ON oauth_states
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    OR user_id   = nullif(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_states TO meridian_app;
