-- =============================================================================
-- Migration: Expand daily challenge types and remove football jeopardy
-- =============================================================================

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
      'football_logic'
    )
  );

DELETE FROM daily_challenge_completions
WHERE challenge_type = 'footballJeopardy';

DELETE FROM daily_challenge_configs
WHERE challenge_type = 'footballJeopardy';

ALTER TABLE daily_challenge_configs
  DROP CONSTRAINT IF EXISTS chk_daily_challenge_type;

ALTER TABLE daily_challenge_configs
  ADD CONSTRAINT chk_daily_challenge_type
  CHECK (
    challenge_type IN (
      'moneyDrop',
      'trueFalse',
      'clues',
      'countdown',
      'putInOrder',
      'imposter',
      'careerPath',
      'highLow',
      'footballLogic'
    )
  );

ALTER TABLE daily_challenge_completions
  DROP CONSTRAINT IF EXISTS chk_daily_completion_type;

ALTER TABLE daily_challenge_completions
  ADD CONSTRAINT chk_daily_completion_type
  CHECK (
    challenge_type IN (
      'moneyDrop',
      'trueFalse',
      'clues',
      'countdown',
      'putInOrder',
      'imposter',
      'careerPath',
      'highLow',
      'footballLogic'
    )
  );

INSERT INTO daily_challenge_configs (
  challenge_type,
  is_active,
  sort_order,
  show_on_home,
  coin_reward,
  xp_reward,
  settings
)
VALUES
  (
    'imposter',
    false,
    6,
    false,
    300,
    90,
    jsonb_build_object(
      'challengeType', 'imposter',
      'categoryIds', jsonb_build_array(),
      'questionCount', 5,
      'secondsPerQuestion', 30
    )
  ),
  (
    'careerPath',
    false,
    7,
    false,
    300,
    90,
    jsonb_build_object(
      'challengeType', 'careerPath',
      'categoryIds', jsonb_build_array(),
      'questionCount', 5,
      'secondsPerQuestion', 30
    )
  ),
  (
    'highLow',
    false,
    8,
    false,
    300,
    90,
    jsonb_build_object(
      'challengeType', 'highLow',
      'categoryIds', jsonb_build_array(),
      'roundCount', 3,
      'secondsPerRound', 30
    )
  ),
  (
    'footballLogic',
    false,
    9,
    false,
    300,
    90,
    jsonb_build_object(
      'challengeType', 'footballLogic',
      'categoryIds', jsonb_build_array(),
      'questionCount', 5,
      'secondsPerQuestion', 30
    )
  )
ON CONFLICT (challenge_type)
DO UPDATE SET
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order,
  show_on_home = EXCLUDED.show_on_home,
  coin_reward = EXCLUDED.coin_reward,
  xp_reward = EXCLUDED.xp_reward,
  settings = EXCLUDED.settings,
  updated_at = NOW();
