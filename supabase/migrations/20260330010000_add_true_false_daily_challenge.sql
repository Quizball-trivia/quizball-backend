ALTER TABLE daily_challenge_configs
  DROP CONSTRAINT IF EXISTS chk_daily_challenge_type;

ALTER TABLE daily_challenge_configs
  ADD CONSTRAINT chk_daily_challenge_type
  CHECK (
    challenge_type IN ('moneyDrop', 'footballJeopardy', 'trueFalse', 'clues', 'countdown', 'putInOrder')
  );

ALTER TABLE daily_challenge_completions
  DROP CONSTRAINT IF EXISTS chk_daily_completion_type;

ALTER TABLE daily_challenge_completions
  ADD CONSTRAINT chk_daily_completion_type
  CHECK (
    challenge_type IN ('moneyDrop', 'footballJeopardy', 'trueFalse', 'clues', 'countdown', 'putInOrder')
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
VALUES (
  'trueFalse',
  false,
  6,
  false,
  75,
  120,
  '{"challengeType":"trueFalse","categoryIds":[],"questionCount":10,"secondsPerQuestion":15}'::jsonb
)
ON CONFLICT (challenge_type) DO NOTHING;
