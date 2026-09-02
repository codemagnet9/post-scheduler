-- db/migrations/0009_workspace_read_creator.sql
-- Bug found by the integration suite: createWorkspace does INSERT ... RETURNING, and RETURNING
-- re-reads the new row through the SELECT policy. At creation time app.workspace_id isn't this new
-- id yet and no membership exists, so workspaces_read denied it and the insert failed. Allow reading
-- a workspace you created (safe: it's your own row; a membership is created moments later anyway).
DROP POLICY workspaces_read ON workspaces;
CREATE POLICY workspaces_read ON workspaces FOR SELECT USING (
  id = nullif(current_setting('app.workspace_id', true), '')::uuid
  OR created_by = nullif(current_setting('app.user_id', true), '')::uuid
  OR EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.workspace_id = workspaces.id
      AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid
  )
);
