-- db/migrations/0004_tenant_rls.sql
-- The workspace-scoping chokepoint: Postgres Row-Level Security.
-- The app connects as meridian_app (NOSUPERUSER, NOBYPASSRLS). Every tenant query is
-- filtered by the transaction-local GUC app.workspace_id. A query with no workspace set
-- (i.e. run outside withTenant) sees ZERO rows — fail closed.
--
-- Migrations run as the owner/migration role; the running app must use meridian_app.

-- 1) Application role. Password is set out-of-band (env / secret manager).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian_app') THEN
    CREATE ROLE meridian_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- 2) Denormalize workspace_id onto tenant child tables that only carried a parent id,
--    so every tenant table can use the same one-column RLS policy (no per-row EXISTS join).
ALTER TABLE oauth_tokens          ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE media_variants        ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE post_target_overrides ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
ALTER TABLE publish_attempts      ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
-- (Fresh DB: no backfill. These become NOT NULL once the app always writes them — Phase 5/7.)
CREATE INDEX oauth_tokens_ws_idx          ON oauth_tokens (workspace_id);
CREATE INDEX media_variants_ws_idx        ON media_variants (workspace_id);
CREATE INDEX post_target_overrides_ws_idx ON post_target_overrides (workspace_id);
CREATE INDEX publish_attempts_ws_idx      ON publish_attempts (workspace_id);

-- 3) Controlled RLS-bypass for the invite-accept bootstrap: the invitee is not yet a member,
--    so they cannot see the invitation under RLS. SECURITY DEFINER runs as the owner but is
--    tightly scoped to exactly this operation.
CREATE FUNCTION app_accept_invitation(p_token_hash text, p_user_id uuid)
RETURNS TABLE(workspace_id uuid, role member_role)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv invitations%ROWTYPE;
BEGIN
  SELECT * INTO inv FROM invitations
    WHERE token_hash = p_token_hash AND status = 'pending' AND expires_at > now()
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'invitation_invalid' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO memberships (workspace_id, user_id, role, invited_by)
    VALUES (inv.workspace_id, p_user_id, inv.role, inv.invited_by)
    ON CONFLICT (workspace_id, user_id) DO NOTHING;
  UPDATE invitations SET status = 'accepted', accepted_at = now() WHERE id = inv.id;
  RETURN QUERY SELECT inv.workspace_id, inv.role;
END $$;

-- 4) Enable RLS + the standard tenant policy on every workspace-scoped table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'connected_accounts','oauth_tokens','media_assets','media_variants','queue_slots',
    'posts','post_targets','post_target_overrides','publish_attempts','approval_requests',
    'comments','api_keys','api_idempotency_keys','webhook_endpoints','webhook_deliveries',
    'events','metric_snapshots','usage_counters'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        USING      (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
        WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
    $p$, t);
  END LOOP;
END $$;

-- 5) Special cases.

-- workspaces: visible within its own context OR to any of its members (powers the switcher).
--             Insert allowed only for a workspace you create as yourself.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_read ON workspaces FOR SELECT USING (
  id = nullif(current_setting('app.workspace_id', true), '')::uuid
  OR EXISTS (SELECT 1 FROM memberships m
             WHERE m.workspace_id = workspaces.id
               AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid)
);
CREATE POLICY workspaces_write ON workspaces FOR UPDATE
  USING (id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY workspaces_insert ON workspaces FOR INSERT
  WITH CHECK (created_by = nullif(current_setting('app.user_id', true), '')::uuid);

-- memberships: a user always sees their OWN rows (needed to resolve tenant + list workspaces);
--              inside a workspace context, sees that workspace's roster. Writes are scoped to ctx.
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_read ON memberships FOR SELECT USING (
  workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  OR user_id   = nullif(current_setting('app.user_id', true), '')::uuid
);
CREATE POLICY memberships_write ON memberships FOR ALL
  USING      (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- invitations: standard tenant policy for management; acceptance uses app_accept_invitation().
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY invitations_tenant ON invitations
  USING      (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- audit_log: append-only. Readable only within its workspace. Insert allowed within a workspace
--            context OR for null-workspace security events (login, reset) when a user is set.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON audit_log FOR SELECT
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (
  workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  OR (workspace_id IS NULL AND nullif(current_setting('app.user_id', true), '') IS NOT NULL)
);

-- 6) Grants. meridian_app gets DML on tenant + user tables, but audit_log is append-only.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO meridian_app;
REVOKE UPDATE, DELETE ON audit_log FROM meridian_app;
GRANT EXECUTE ON FUNCTION app_accept_invitation(text, uuid) TO meridian_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO meridian_app;
