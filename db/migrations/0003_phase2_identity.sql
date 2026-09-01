-- db/migrations/0003_phase2_identity.sql
-- Phase 2: OAuth identities, email-verification / password-reset tokens,
-- refresh-session rotation columns, and a Postgres-backed rate limiter.

CREATE TYPE user_token_purpose AS ENUM ('email_verification','password_reset','email_change');

-- Federated sign-in. We link by (provider, subject), NEVER auto-link by email — matching an
-- existing password account on email alone is an account-takeover vector.
CREATE TABLE user_identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider         text NOT NULL,              -- 'google' | 'apple'
  provider_subject text NOT NULL,              -- the provider's stable 'sub'
  email            citext,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_identities_provider_subject_key UNIQUE (provider, provider_subject) -- serves: federated login lookup
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id); -- serves: "linked logins" on settings

-- Single-use, hashed, expiring tokens for email verification / password reset / email change.
CREATE TABLE user_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     user_token_purpose NOT NULL,
  token_hash  text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}',     -- e.g. the new address for email_change
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT user_tokens_hash_key UNIQUE (token_hash)  -- serves: verify/reset lookup by link
);
CREATE INDEX user_tokens_user_purpose_idx ON user_tokens (user_id, purpose); -- serves: invalidate prior tokens

-- Refresh-token rotation + theft detection on the existing sessions table.
ALTER TABLE sessions
  ADD COLUMN previous_token_hash text,  -- last rotated value; a replay of it => compromise
  ADD COLUMN rotated_at          timestamptz,
  ADD COLUMN revoked_at          timestamptz;  -- set by logout / logout-everywhere / reuse detection
CREATE INDEX sessions_prev_hash_idx ON sessions (previous_token_hash) WHERE previous_token_hash IS NOT NULL;

-- Fixed-window rate limiter (multi-instance safe; no Redis in the MVP).
CREATE TABLE rate_limits (
  bucket_key   text NOT NULL,
  window_start timestamptz NOT NULL,
  count        int NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start)
);
-- serves: periodic cleanup of expired windows
CREATE INDEX rate_limits_window_idx ON rate_limits (window_start);
