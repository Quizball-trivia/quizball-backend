-- Stat Sniper daily challenge: closest-guess numeric football facts.
ALTER TABLE questions
  DROP CONSTRAINT IF EXISTS chk_questions_type;

ALTER TABLE questions
  ADD CONSTRAINT chk_questions_type
  CHECK (
    type IN (
      'mcq_single',
      'true_false',
      'input_text',
      'countdown_list',
      'clue_chain',
      'put_in_order',
      'imposter_multi_select',
      'career_path',
      'high_low',
      'football_logic',
      'clues',
      'countdown',
      'imposter',
      'missing_xi',
      'pass_chain',
      'stat_sniper'
    )
  ) NOT VALID;

ALTER TABLE daily_challenge_configs
  DROP CONSTRAINT IF EXISTS chk_daily_challenge_type;
ALTER TABLE daily_challenge_configs
  ADD CONSTRAINT chk_daily_challenge_type
  CHECK (challenge_type IN (
    'moneyDrop', 'trueFalse', 'clues', 'countdown', 'putInOrder',
    'imposter', 'careerPath', 'highLow', 'footballLogic', 'fifaCards', 'cardDetective', 'missingXi', 'passChain', 'statSniper'
  )) NOT VALID;

ALTER TABLE daily_challenge_completions
  DROP CONSTRAINT IF EXISTS chk_daily_completion_type;
ALTER TABLE daily_challenge_completions
  ADD CONSTRAINT chk_daily_completion_type
  CHECK (challenge_type IN (
    'moneyDrop', 'trueFalse', 'clues', 'countdown', 'putInOrder',
    'imposter', 'careerPath', 'highLow', 'footballLogic', 'fifaCards', 'cardDetective', 'missingXi', 'passChain', 'statSniper'
  )) NOT VALID;

-- Leaderboard reads: top scores for one challenge type on one day.
CREATE INDEX IF NOT EXISTS idx_daily_completions_type_day_score
  ON daily_challenge_completions (challenge_type, challenge_day, score DESC);
