-- migrate:no-transaction
-- Validate the challenge_type CHECKs widened (NOT VALID) by the previous
-- migration. Runs outside a transaction so each VALIDATE takes only a
-- SHARE UPDATE EXCLUSIVE lock; re-running is a harmless no-op.
ALTER TABLE daily_challenge_configs VALIDATE CONSTRAINT chk_daily_challenge_type;
ALTER TABLE daily_challenge_completions VALIDATE CONSTRAINT chk_daily_completion_type;
