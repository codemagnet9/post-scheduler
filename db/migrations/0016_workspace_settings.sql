-- db/migrations/0016_workspace_settings.sql
-- Free-form workspace preferences (week start, posting-default toggles) behind the Settings screen.
-- jsonb so adding a preference never needs a migration; name/default_timezone stay first-class columns.
ALTER TABLE workspaces ADD COLUMN settings jsonb NOT NULL DEFAULT '{}';
