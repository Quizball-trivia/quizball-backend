-- migrate:no-transaction
-- Validate the CHECKs added NOT VALID by the previous migration; each VALIDATE
-- takes only SHARE UPDATE EXCLUSIVE. Re-running is a harmless no-op.
ALTER TABLE questions VALIDATE CONSTRAINT chk_questions_type;
ALTER TABLE daily_challenge_configs VALIDATE CONSTRAINT chk_daily_challenge_type;
ALTER TABLE daily_challenge_completions VALIDATE CONSTRAINT chk_daily_completion_type;
