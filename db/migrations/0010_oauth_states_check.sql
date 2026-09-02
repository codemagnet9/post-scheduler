-- db/migrations/0010_oauth_states_check.sql
-- Bug found by the integration suite: the OAuth callback consumes its state with
--   UPDATE oauth_states SET consumed_at = now() ... RETURNING workspace_id, ...
-- and it runs under withUser (no workspace context — we don't know the workspace until we read the
-- state). The WITH CHECK (workspace_id = app.workspace_id) then failed because app.workspace_id is
-- unset during the callback. Allow the owning user to modify their own state rows too. Safe: the
-- update only sets consumed_at, and user_id can't be changed to someone else under this same check.
DROP POLICY oauth_states_rw ON oauth_states;
CREATE POLICY oauth_states_rw ON oauth_states
  USING (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    OR user_id   = nullif(current_setting('app.user_id', true), '')::uuid
  )
  WITH CHECK (
    workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
    OR user_id   = nullif(current_setting('app.user_id', true), '')::uuid
  );
