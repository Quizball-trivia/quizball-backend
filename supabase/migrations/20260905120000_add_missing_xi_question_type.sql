-- Missing XI daily challenge: famous starting line-ups as typed-answer questions.
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
      'missing_xi'
    )
  ) NOT VALID;

-- Same NOT VALID pattern as the FIFA Cards migration: instant, no table scan;
-- validate later outside a transaction so live completions are never blocked.
ALTER TABLE daily_challenge_configs
  DROP CONSTRAINT IF EXISTS chk_daily_challenge_type;
ALTER TABLE daily_challenge_configs
  ADD CONSTRAINT chk_daily_challenge_type
  CHECK (challenge_type IN (
    'moneyDrop', 'trueFalse', 'clues', 'countdown', 'putInOrder',
    'imposter', 'careerPath', 'highLow', 'footballLogic', 'fifaCards', 'missingXi'
  )) NOT VALID;

ALTER TABLE daily_challenge_completions
  DROP CONSTRAINT IF EXISTS chk_daily_completion_type;
ALTER TABLE daily_challenge_completions
  ADD CONSTRAINT chk_daily_completion_type
  CHECK (challenge_type IN (
    'moneyDrop', 'trueFalse', 'clues', 'countdown', 'putInOrder',
    'imposter', 'careerPath', 'highLow', 'footballLogic', 'fifaCards', 'missingXi'
  )) NOT VALID;
