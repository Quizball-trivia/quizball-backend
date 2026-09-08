-- migrate:no-transaction
-- Re-create the daily challenge_type CHECKs with the complete type list before
-- validating: an earlier run of the forward migration may have installed a
-- list that predates Card Detective, and VALIDATE would then fail on its rows.
-- Idempotent; NOT VALID keeps the swap instant.
ALTER TABLE daily_challenge_configs DROP CONSTRAINT IF EXISTS chk_daily_challenge_type;
ALTER TABLE daily_challenge_configs ADD CONSTRAINT chk_daily_challenge_type
  CHECK (challenge_type IN (
    'moneyDrop', 'trueFalse', 'clues', 'countdown', 'putInOrder',
    'imposter', 'careerPath', 'highLow', 'footballLogic', 'fifaCards', 'cardDetective',
    'missingXi', 'passChain', 'statSniper'
  )) NOT VALID;
ALTER TABLE daily_challenge_completions DROP CONSTRAINT IF EXISTS chk_daily_completion_type;
ALTER TABLE daily_challenge_completions ADD CONSTRAINT chk_daily_completion_type
  CHECK (challenge_type IN (
    'moneyDrop', 'trueFalse', 'clues', 'countdown', 'putInOrder',
    'imposter', 'careerPath', 'highLow', 'footballLogic', 'fifaCards', 'cardDetective',
    'missingXi', 'passChain', 'statSniper'
  )) NOT VALID;
ALTER TABLE questions VALIDATE CONSTRAINT chk_questions_type;
ALTER TABLE daily_challenge_configs VALIDATE CONSTRAINT chk_daily_challenge_type;
ALTER TABLE daily_challenge_completions VALIDATE CONSTRAINT chk_daily_completion_type;
