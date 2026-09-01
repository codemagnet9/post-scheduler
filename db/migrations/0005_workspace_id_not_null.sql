-- db/migrations/0005_workspace_id_not_null.sql
-- Make the four denormalized workspace_id columns NOT NULL so a null-tenant row can never exist.
-- A NULL workspace_id under RLS matches no tenant => invisible to everyone => fails closed
-- SILENTLY. NOT NULL turns that into a loud insert error instead.
--
-- Belt-and-suspenders: a BEFORE INSERT trigger derives workspace_id from the parent row when the
-- writer omits it, so application code cannot forget it. Because the parent read is itself under
-- RLS, this also enforces an invariant — you cannot attach a child to a parent in another tenant
-- (the parent read returns nothing => workspace_id stays NULL => NOT NULL rejects the insert).

CREATE FUNCTION derive_workspace_id() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_table text := TG_ARGV[0];
  fk_col       text := TG_ARGV[1];
  fk_val       uuid;
  ws           uuid;
BEGIN
  IF NEW.workspace_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT ($1).%I', fk_col) INTO fk_val USING NEW;
  EXECUTE format('SELECT workspace_id FROM %I WHERE id = $1', parent_table) INTO ws USING fk_val;
  NEW.workspace_id := ws;  -- may stay NULL if parent is invisible/absent -> NOT NULL rejects it
  RETURN NEW;
END $$;

CREATE TRIGGER oauth_tokens_derive_ws BEFORE INSERT ON oauth_tokens
  FOR EACH ROW EXECUTE FUNCTION derive_workspace_id('connected_accounts', 'connected_account_id');
CREATE TRIGGER media_variants_derive_ws BEFORE INSERT ON media_variants
  FOR EACH ROW EXECUTE FUNCTION derive_workspace_id('media_assets', 'media_asset_id');
CREATE TRIGGER post_target_overrides_derive_ws BEFORE INSERT ON post_target_overrides
  FOR EACH ROW EXECUTE FUNCTION derive_workspace_id('post_targets', 'post_target_id');
CREATE TRIGGER publish_attempts_derive_ws BEFORE INSERT ON publish_attempts
  FOR EACH ROW EXECUTE FUNCTION derive_workspace_id('post_targets', 'post_target_id');

ALTER TABLE oauth_tokens          ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE media_variants        ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE post_target_overrides ALTER COLUMN workspace_id SET NOT NULL;
ALTER TABLE publish_attempts      ALTER COLUMN workspace_id SET NOT NULL;
