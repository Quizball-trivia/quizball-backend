-- =============================================================================
-- Migration: Add CMS-controlled daily challenges
-- =============================================================================

ALTER TABLE questions
  DROP CONSTRAINT IF EXISTS chk_questions_type;

ALTER TABLE questions
  ADD CONSTRAINT chk_questions_type
  CHECK (type IN ('mcq_single', 'input_text', 'countdown_list', 'clue_chain', 'put_in_order'));

CREATE TABLE IF NOT EXISTS daily_challenge_configs (
  challenge_type TEXT PRIMARY KEY,
  is_active BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  show_on_home BOOLEAN NOT NULL DEFAULT false,
  coin_reward INTEGER NOT NULL DEFAULT 0,
  xp_reward INTEGER NOT NULL DEFAULT 0,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_daily_challenge_type CHECK (
    challenge_type IN ('moneyDrop', 'footballJeopardy', 'clues', 'countdown', 'putInOrder')
  ),
  CONSTRAINT chk_daily_challenge_coin_reward CHECK (coin_reward >= 0),
  CONSTRAINT chk_daily_challenge_xp_reward CHECK (xp_reward >= 0)
);

DROP TRIGGER IF EXISTS trg_daily_challenge_configs_set_updated_at ON daily_challenge_configs;
CREATE TRIGGER trg_daily_challenge_configs_set_updated_at
  BEFORE UPDATE ON daily_challenge_configs
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE IF NOT EXISTS daily_challenge_completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_type TEXT NOT NULL,
  challenge_day DATE NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  coins_awarded INTEGER NOT NULL DEFAULT 0,
  xp_awarded INTEGER NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_daily_challenge_completion UNIQUE (user_id, challenge_type, challenge_day),
  CONSTRAINT chk_daily_completion_type CHECK (
    challenge_type IN ('moneyDrop', 'footballJeopardy', 'clues', 'countdown', 'putInOrder')
  ),
  CONSTRAINT chk_daily_completion_score CHECK (score >= 0),
  CONSTRAINT chk_daily_completion_coins CHECK (coins_awarded >= 0),
  CONSTRAINT chk_daily_completion_xp CHECK (xp_awarded >= 0)
);

CREATE INDEX IF NOT EXISTS idx_daily_challenge_completions_user_day
  ON daily_challenge_completions (user_id, challenge_day DESC);

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
    'moneyDrop',
    true,
    1,
    true,
    500,
    120,
    jsonb_build_object(
      'categoryIds', jsonb_build_array(),
      'questionCount', 5,
      'secondsPerQuestion', 40,
      'startingMoney', 1000
    )
  ),
  (
    'footballJeopardy',
    true,
    2,
    true,
    400,
    100,
    jsonb_build_object(
      'categoryIds', jsonb_build_array(),
      'pickCount', 5
    )
  ),
  (
    'clues',
    true,
    3,
    false,
    300,
    90,
    jsonb_build_object(
      'categoryIds', jsonb_build_array(),
      'questionCount', 5,
      'secondsPerClueStep', 15
    )
  ),
  (
    'countdown',
    true,
    4,
    false,
    350,
    100,
    jsonb_build_object(
      'categoryIds', jsonb_build_array(),
      'roundCount', 2,
      'secondsPerRound', 30
    )
  ),
  (
    'putInOrder',
    true,
    5,
    false,
    250,
    80,
    jsonb_build_object(
      'categoryIds', jsonb_build_array(),
      'roundCount', 3,
      'itemsPerRound', 4
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
