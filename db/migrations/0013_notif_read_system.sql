-- db/migrations/0013_notif_read_system.sql
-- Bug found by the notification tests: the dispatcher inserts notifications FOR OTHER USERS under the
-- system context, and INSERT ... RETURNING re-reads the new row through notif_read, which required
-- user_id = app.user_id -> the RETURNING failed and the insert was silently skipped. Allow the system
-- user (SYSTEM_USER_ID) to read workspace notifications; real users still see only their own (a
-- session's app.user_id is their real id and can never be the system sentinel).
DROP POLICY notif_read ON notifications;
CREATE POLICY notif_read ON notifications FOR SELECT USING (
  workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
  AND (
    user_id = nullif(current_setting('app.user_id', true), '')::uuid
    OR nullif(current_setting('app.user_id', true), '')::uuid = '00000000-0000-0000-0000-000000000000'::uuid
  )
);
