-- Changes that were being built go back to their plan.
UPDATE harness.game_changes SET status = 'planned', updated_at = now() WHERE status IN ('building', 'ready');
DROP INDEX IF EXISTS harness.harness_game_changes_building;
ALTER TABLE harness.game_changes DROP COLUMN IF EXISTS build_id, DROP COLUMN IF EXISTS build_started_at, DROP COLUMN IF EXISTS builds, DROP COLUMN IF EXISTS approving_until;
NOTIFY pgrst, 'reload schema';
