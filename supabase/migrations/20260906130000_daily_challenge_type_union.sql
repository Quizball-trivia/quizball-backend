-- Reconcile the challenge_type CHECKs: the Stat Sniper (20260905190000) and Card Detective
-- (20260906120000) migrations each re-listed the types without the other's additions, so
-- whichever ran last dropped valid types. This is the complete union; NOT VALID keeps it instant.
ALTER TABLE daily_challenge_configs
  DROP CONSTRAINT IF EXISTS chk_daily_challenge_type;
ALTER TABLE daily_challenge_configs
  ADD CONSTRAINT chk_daily_challenge_type
  CHECK (challenge_type IN (
    'moneyDrop', 'trueFalse', 'clues', 'countdown', 'putInOrder',
    'imposter', 'careerPath', 'highLow', 'footballLogic', 'fifaCards', 'cardDetective',
    'missingXi', 'passChain', 'statSniper'
  )) NOT VALID;

ALTER TABLE daily_challenge_completions
  DROP CONSTRAINT IF EXISTS chk_daily_completion_type;
ALTER TABLE daily_challenge_completions
  ADD CONSTRAINT chk_daily_completion_type
  CHECK (challenge_type IN (
    'moneyDrop', 'trueFalse', 'clues', 'countdown', 'putInOrder',
    'imposter', 'careerPath', 'highLow', 'footballLogic', 'fifaCards', 'cardDetective',
    'missingXi', 'passChain', 'statSniper'
  )) NOT VALID;
