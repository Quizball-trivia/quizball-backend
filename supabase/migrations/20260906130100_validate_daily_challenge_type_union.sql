-- migrate:no-transaction
ALTER TABLE daily_challenge_configs VALIDATE CONSTRAINT chk_daily_challenge_type;
ALTER TABLE daily_challenge_completions VALIDATE CONSTRAINT chk_daily_completion_type;
