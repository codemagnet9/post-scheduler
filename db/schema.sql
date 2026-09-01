-- db/schema.sql
-- Meridian — canonical PostgreSQL schema (Phase 1, initial migration).
-- Conventions:
--   * All PKs are uuid. Hot/append tables (post_targets, events, audit_log) use
--     app-generated UUIDv7 for index locality; gen_random_uuid() is the DB fallback.
--   * All instants are timestamptz (stored UTC). Wall-clock intent is stored
--     separately as (local_time text, local_date date) + the account's IANA zone.
--     A naive timestamp is NEVER used to smuggle a wall-clock value.
--   * Every tenant-owned row carries workspace_id (denormalized where needed) so
--     tenant isolation is a leading index column and, later, a Row-Level-Security key.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS citext;     -- case-insensitive email

-- ---------------------------------------------------------------------------
-- Enum types (native; ALTER TYPE ... ADD VALUE keeps them evolvable).
-- ---------------------------------------------------------------------------
CREATE TYPE member_role            AS ENUM ('owner','approver','editor','analyst');
CREATE TYPE invitation_status      AS ENUM ('pending','accepted','revoked','expired');
CREATE TYPE account_status         AS ENUM ('active','auth_expired','disconnected','needs_review');
CREATE TYPE schedule_type          AS ENUM ('fixed_instant','audience_local','queued');
CREATE TYPE post_status            AS ENUM ('draft','pending_approval','changes_requested',
                                            'approved','scheduled','publishing','published',
                                            'partially_published','failed','canceled');
CREATE TYPE target_state           AS ENUM ('draft','scheduled','publishing','published',
                                            'failed','needs_review','canceled','skipped');
CREATE TYPE failure_code           AS ENUM ('rate_limited','auth_expired','invalid_media',
                                            'content_rejected','duplicate_content',
                                            'provider_unavailable','permanent_failure');
CREATE TYPE media_kind             AS ENUM ('image','video','gif');
CREATE TYPE media_status           AS ENUM ('uploading','processing','ready','failed');
CREATE TYPE approval_status        AS ENUM ('pending','approved','changes_requested','canceled');
CREATE TYPE webhook_delivery_status AS ENUM ('pending','delivering','succeeded','failed','exhausted');
CREATE TYPE publish_attempt_status AS ENUM ('started','succeeded','failed','ambiguous','recovered');
CREATE TYPE api_idempotency_status AS ENUM ('in_progress','completed');

-- Shared updated_at trigger.
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext NOT NULL,
  email_verified_at timestamptz,
  password_hash   text,                       -- null for SSO-only users
  name            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email)    -- serves: login + invite matching
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL,
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  expires_at    timestamptz NOT NULL,
  CONSTRAINT sessions_token_hash_key UNIQUE (token_hash)  -- serves: auth lookup by cookie
);
CREATE INDEX sessions_user_idx    ON sessions (user_id);              -- serves: "my active sessions"
CREATE INDEX sessions_expiry_idx  ON sessions (expires_at);          -- serves: expiry sweeper

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE workspaces (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  slug              text NOT NULL,
  default_timezone  text NOT NULL DEFAULT 'UTC',   -- IANA; account tz overrides it
  plan_tier         text NOT NULL DEFAULT 'trial',
  billing_customer_id text,
  created_by        uuid REFERENCES users(id) ON DELETE RESTRICT,
  deleted_at        timestamptz,                    -- soft delete; hard-delete is Phase 11
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_slug_key UNIQUE (slug)      -- serves: workspace routing by slug
);
CREATE TRIGGER workspaces_touch BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          member_role NOT NULL,
  invited_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memberships_ws_user_key UNIQUE (workspace_id, user_id)  -- one role per user per ws
);
CREATE INDEX memberships_user_idx     ON memberships (user_id);                 -- serves: "workspaces I belong to"
CREATE INDEX memberships_ws_role_idx  ON memberships (workspace_id, role);      -- serves: "list Approvers to notify"

CREATE TABLE invitations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email         citext NOT NULL,
  role          member_role NOT NULL,
  token_hash    text NOT NULL,
  invited_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  status        invitation_status NOT NULL DEFAULT 'pending',
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  CONSTRAINT invitations_token_key UNIQUE (token_hash)              -- serves: accept-by-link
);
-- serves: block a second pending invite to the same address; accepted/revoked don't collide
CREATE UNIQUE INDEX invitations_pending_email_idx
  ON invitations (workspace_id, email) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Connected accounts + token vault
-- ---------------------------------------------------------------------------
CREATE TABLE connected_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider            text NOT NULL,               -- registered adapter key, e.g. 'instagram','zalo'
  provider_account_id text NOT NULL,               -- the account id on the provider side
  handle              text,
  display_name        text,
  avatar_url          text,
  timezone            text NOT NULL,               -- IANA zone = this account's market (drives audience-local)
  market              text,                        -- ISO country code, informational
  status              account_status NOT NULL DEFAULT 'active',
  capabilities_version text,                       -- descriptor version this account was last validated against
  connected_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  last_synced_at      timestamptz,
  -- Same provider account may live in many workspaces (multi-tenant) but only once per workspace:
  CONSTRAINT connected_accounts_ws_provider_acct_key
    UNIQUE (workspace_id, provider, provider_account_id)
);
CREATE INDEX connected_accounts_ws_idx ON connected_accounts (workspace_id);  -- serves: "connected networks" screen
-- serves: worker sweep for accounts that need attention (re-auth / review)
CREATE INDEX connected_accounts_attention_idx
  ON connected_accounts (workspace_id) WHERE status IN ('auth_expired','needs_review');
CREATE TRIGGER connected_accounts_touch BEFORE UPDATE ON connected_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE oauth_tokens (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connected_account_id     uuid NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  access_token_ciphertext  bytea NOT NULL,
  refresh_token_ciphertext bytea,
  key_id                   text NOT NULL,          -- versioned encryption key id (rotate without re-login)
  scopes                   text[] NOT NULL DEFAULT '{}',
  access_expires_at        timestamptz,
  refresh_expires_at       timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  rotated_at               timestamptz,
  CONSTRAINT oauth_tokens_account_key UNIQUE (connected_account_id)   -- one live credential set per account
);
-- serves: refresh worker — "tokens expiring in the next N minutes that CAN be refreshed"
CREATE INDEX oauth_tokens_refresh_due_idx
  ON oauth_tokens (access_expires_at) WHERE refresh_token_ciphertext IS NOT NULL;
CREATE TRIGGER oauth_tokens_touch BEFORE UPDATE ON oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Media
-- ---------------------------------------------------------------------------
CREATE TABLE media_assets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  uploaded_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  kind              media_kind NOT NULL,
  storage_key       text NOT NULL,
  original_filename text,
  mime_type         text NOT NULL,
  byte_size         bigint,
  width             int,
  height            int,
  duration_ms       int,
  checksum_sha256   bytea,
  status            media_status NOT NULL DEFAULT 'uploading',
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_assets_library_idx ON media_assets (workspace_id, created_at DESC); -- serves: media library grid
CREATE INDEX media_assets_dedup_idx   ON media_assets (workspace_id, checksum_sha256); -- serves: "already uploaded?" dedup

CREATE TABLE media_variants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  purpose        text NOT NULL,                    -- e.g. 'ig_feed_1_1','x_16_9','thumbnail'
  storage_key    text NOT NULL,
  mime_type      text NOT NULL,
  width          int,
  height         int,
  byte_size      bigint,
  duration_ms    int,
  status         media_status NOT NULL DEFAULT 'processing',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_variants_asset_purpose_key UNIQUE (media_asset_id, purpose) -- serves: fetch the variant a network needs
);

-- ---------------------------------------------------------------------------
-- Queue slots (recurring weekly, per market)
-- ---------------------------------------------------------------------------
CREATE TABLE queue_slots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  market_timezone  text NOT NULL,                  -- IANA zone identifying the market
  label            text,
  day_of_week      smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  local_time       text NOT NULL,                  -- 'HH:MM' wall-clock in market_timezone
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT queue_slots_unique
    UNIQUE (workspace_id, market_timezone, day_of_week, local_time)  -- no duplicate slot
);
-- serves: "next open slot in this market" reflow ordering
CREATE INDEX queue_slots_reflow_idx
  ON queue_slots (workspace_id, market_timezone, day_of_week, local_time) WHERE active;
CREATE TRIGGER queue_slots_touch BEFORE UPDATE ON queue_slots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Posts (the logical content) + targets (per-account fan-out)
-- ---------------------------------------------------------------------------
CREATE TABLE posts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  author_id             uuid REFERENCES users(id) ON DELETE SET NULL,
  status                post_status NOT NULL DEFAULT 'draft',
  content               jsonb NOT NULL DEFAULT '{}',  -- parent text/link/first_comment/media[] targets inherit
  schedule_type         schedule_type,               -- null while draft
  scheduled_at          timestamptz,                 -- fixed_instant: the single absolute instant
  scheduled_local_time  text,                        -- audience_local/queued: 'HH:MM' wall-clock
  scheduled_local_date  date,                        -- audience_local: the intended calendar date
  queue_market_timezone text,                        -- queued: which market's queue this sits in
  queue_slot_id         uuid REFERENCES queue_slots(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX posts_ws_status_idx   ON posts (workspace_id, status);            -- serves: home lists by status
CREATE INDEX posts_ws_calendar_idx ON posts (workspace_id, scheduled_at);     -- serves: calendar month view
CREATE INDEX posts_queue_idx       ON posts (workspace_id, queue_market_timezone, scheduled_at)
  WHERE schedule_type = 'queued';                                             -- serves: queue view + reflow order
CREATE TRIGGER posts_touch BEFORE UPDATE ON posts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE post_targets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- app supplies UUIDv7
  post_id              uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, -- denormalized for tenant scans/RLS
  connected_account_id uuid NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  state                target_state NOT NULL DEFAULT 'draft',
  scheduled_at         timestamptz,        -- immutable intended instant (UI truth), materialized per-account
  publish_due_at       timestamptz,        -- operational next-attempt instant (bumped on retry)
  rendered_payload     jsonb,              -- merged parent+override, frozen when claimed for publish
  content_fingerprint  text,              -- stable hash of rendered content, for recent-post-lookup dedup
  provider_post_id     text,              -- set on success — the ONLY truth of "did it publish"
  provider_permalink   text,
  failure_code         failure_code,      -- normalized taxonomy; retry policy keys off this, never a raw string
  last_error           jsonb,             -- {code, retryAfter, providerRaw, plainLanguage}
  attempt_count        int NOT NULL DEFAULT 0,
  published_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT post_targets_post_account_key UNIQUE (post_id, connected_account_id) -- one target per account per post
);
-- THE due-scan index. Partial on the hot state so of 10M rows only the few thousand
-- still 'scheduled' are indexed; B-tree order on publish_due_at satisfies both the
-- range predicate and the ORDER BY. Rows leave the index the instant they flip to
-- 'publishing', keeping it tiny and cache-resident.
--   SELECT ... FROM post_targets WHERE state='scheduled' AND publish_due_at <= now()
--   ORDER BY publish_due_at FOR UPDATE SKIP LOCKED LIMIT :batch;
CREATE INDEX post_targets_due_idx ON post_targets (publish_due_at) WHERE state = 'scheduled';
CREATE INDEX post_targets_post_idx    ON post_targets (post_id);                    -- serves: render a post's fan-out
CREATE INDEX post_targets_ws_state_idx ON post_targets (workspace_id, state);       -- serves: activity/queue filters
CREATE INDEX post_targets_account_idx ON post_targets (connected_account_id, published_at DESC); -- serves: per-account history
CREATE TRIGGER post_targets_touch BEFORE UPDATE ON post_targets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Overrides: one row per target. NULL column = inherit from parent; non-null
-- (including '' or '[]') = explicit override. This is the whole merge rule.
CREATE TABLE post_target_overrides (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_target_id         uuid NOT NULL REFERENCES post_targets(id) ON DELETE CASCADE,
  text_override          text,     -- NULL inherit; '' publish empty
  link_override          text,
  first_comment_override text,
  media_override         jsonb,    -- NULL inherit; '[]' no media; '[ids...]' explicit ordered selection
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT post_target_overrides_target_key UNIQUE (post_target_id)
);
CREATE TRIGGER post_target_overrides_touch BEFORE UPDATE ON post_target_overrides
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per publish attempt. The deterministic idempotency_key makes a
-- queue-redelivered job a no-op; the unique constraint is the last-ditch DB guard.
CREATE TABLE publish_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_target_id   uuid NOT NULL REFERENCES post_targets(id) ON DELETE CASCADE,
  attempt_number   int NOT NULL,
  idempotency_key  text NOT NULL,          -- hash(target_id, attempt_number)
  status           publish_attempt_status NOT NULL DEFAULT 'started',
  provider_post_id text,
  error            jsonb,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  CONSTRAINT publish_attempts_target_attempt_key UNIQUE (post_target_id, attempt_number),
  CONSTRAINT publish_attempts_idem_key UNIQUE (idempotency_key)  -- serves: reject duplicate job execution
);
CREATE INDEX publish_attempts_target_idx ON publish_attempts (post_target_id); -- serves: attempt history

-- ---------------------------------------------------------------------------
-- Approvals + collaboration
-- ---------------------------------------------------------------------------
CREATE TABLE approval_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id       uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  status        approval_status NOT NULL DEFAULT 'pending',
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_at    timestamptz
);
CREATE INDEX approval_requests_inbox_idx ON approval_requests (workspace_id, status); -- serves: approver inbox
CREATE UNIQUE INDEX approval_requests_open_idx
  ON approval_requests (post_id) WHERE status = 'pending';  -- serves: one open request per post

CREATE TABLE comments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id       uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  author_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  body          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  edited_at     timestamptz,
  deleted_at    timestamptz
);
CREATE INDEX comments_post_idx ON comments (post_id, created_at); -- serves: post discussion thread

-- ---------------------------------------------------------------------------
-- Public API surface
-- ---------------------------------------------------------------------------
CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  key_prefix   text NOT NULL,          -- shown in UI, e.g. 'mrdn_live_ab12'
  key_hash     text NOT NULL,
  scopes       jsonb NOT NULL DEFAULT '[]',
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  CONSTRAINT api_keys_hash_key UNIQUE (key_hash)  -- serves: bearer-key auth lookup
);
CREATE INDEX api_keys_ws_idx ON api_keys (workspace_id); -- serves: developer console key list

CREATE TABLE api_idempotency_keys (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  idempotency_key     text NOT NULL,       -- client-supplied Idempotency-Key header
  request_fingerprint text NOT NULL,       -- hash(method+path+body) to detect key reuse w/ different body
  status              api_idempotency_status NOT NULL DEFAULT 'in_progress',
  response_status     int,
  response_body       jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  CONSTRAINT api_idempotency_ws_key UNIQUE (workspace_id, idempotency_key) -- serves: replay -> stored response
);

-- ---------------------------------------------------------------------------
-- Eventing (source of truth for feed + webhooks), audit, webhooks
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- app supplies UUIDv7 (ordered)
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  aggregate_type text NOT NULL,          -- 'post','post_target','connected_account',...
  aggregate_id   uuid NOT NULL,
  type           text NOT NULL,          -- 'post_target.published', etc.
  payload        jsonb NOT NULL DEFAULT '{}',
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  fanned_out     boolean NOT NULL DEFAULT false   -- outbox flag for webhook fan-out
);
CREATE INDEX events_feed_idx      ON events (workspace_id, occurred_at DESC);              -- serves: activity feed
CREATE INDEX events_aggregate_idx ON events (aggregate_type, aggregate_id, occurred_at);   -- serves: one entity's history
CREATE INDEX events_outbox_idx    ON events (occurred_at) WHERE NOT fanned_out;            -- serves: webhook dispatcher

CREATE TABLE webhook_endpoints (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url               text NOT NULL,
  secret_ciphertext bytea NOT NULL,          -- signing secret, encrypted
  key_id            text NOT NULL,
  subscribed_events jsonb NOT NULL DEFAULT '[]',
  active            boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_ws_idx ON webhook_endpoints (workspace_id); -- serves: developer console
CREATE TRIGGER webhook_endpoints_touch BEFORE UPDATE ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE webhook_deliveries (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  endpoint_id           uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id              uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  status                webhook_delivery_status NOT NULL DEFAULT 'pending',
  attempt_count         int NOT NULL DEFAULT 0,
  next_attempt_at       timestamptz NOT NULL DEFAULT now(),
  response_status       int,
  response_body_snippet text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  delivered_at          timestamptz,
  CONSTRAINT webhook_deliveries_endpoint_event_key UNIQUE (endpoint_id, event_id) -- deliver each event once per endpoint
);
-- serves: delivery-due scan (mirror of the publish due-scan), partial on retryable states
CREATE INDEX webhook_deliveries_due_idx
  ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending','failed');
CREATE INDEX webhook_deliveries_log_idx ON webhook_deliveries (workspace_id, created_at DESC); -- serves: deliveries log

-- ---------------------------------------------------------------------------
-- Analytics, audit, metering
-- ---------------------------------------------------------------------------
CREATE TABLE metric_snapshots (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  post_target_id       uuid REFERENCES post_targets(id) ON DELETE CASCADE,
  connected_account_id uuid REFERENCES connected_accounts(id) ON DELETE CASCADE,
  captured_at          timestamptz NOT NULL,
  metrics              jsonb NOT NULL DEFAULT '{}',  -- normalized: impressions, likes, comments, shares,...
  CONSTRAINT metric_snapshots_target_time_key UNIQUE (post_target_id, captured_at) -- no dup snapshot
);
CREATE INDEX metric_snapshots_ws_time_idx     ON metric_snapshots (workspace_id, captured_at);            -- serves: analytics range
CREATE INDEX metric_snapshots_target_time_idx ON metric_snapshots (post_target_id, captured_at DESC);     -- serves: a post's metric timeline
-- Scale note: candidate for monthly RANGE partitioning on captured_at (Phase 9/11).

CREATE TABLE audit_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- app supplies UUIDv7 (ordered)
  workspace_id     uuid REFERENCES workspaces(id) ON DELETE SET NULL, -- survive workspace delete
  workspace_slug   text,                          -- denormalized for post-deletion readability
  actor_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  action           text NOT NULL,                 -- 'membership.role_changed','token.decrypted',...
  target_type      text,
  target_id        uuid,
  ip               inet,
  user_agent       text,
  metadata         jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_ws_time_idx   ON audit_log (workspace_id, created_at DESC); -- serves: settings > audit view
CREATE INDEX audit_log_actor_time_idx ON audit_log (actor_user_id, created_at DESC); -- serves: "everything this user did"
-- Append-only: no UPDATE/DELETE granted in application role (enforced Phase 2/11).

CREATE TABLE usage_counters (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  metric        text NOT NULL,             -- 'posts_published','api_calls',...
  period_start  date NOT NULL,             -- billing/rate window start
  count         bigint NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_counters_key UNIQUE (workspace_id, metric, period_start) -- serves: atomic upsert-increment
);
CREATE TRIGGER usage_counters_touch BEFORE UPDATE ON usage_counters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
