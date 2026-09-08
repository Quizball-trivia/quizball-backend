-- Pass Chain daily challenge: link two players through shared clubs.
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
      'pass_chain'
    )
  ) NOT VALID;

ALTER TABLE daily_challenge_configs
  DROP CONSTRAINT IF EXISTS chk_daily_challenge_type;
ALTER TABLE daily_challenge_configs
  ADD CONSTRAINT chk_daily_challenge_type
  CHECK (challenge_type IN (
    'moneyDrop', 'trueFalse', 'clues', 'countdown', 'putInOrder',
    'imposter', 'careerPath', 'highLow', 'footballLogic', 'fifaCards', 'missingXi', 'passChain'
  )) NOT VALID;

ALTER TABLE daily_challenge_completions
  DROP CONSTRAINT IF EXISTS chk_daily_completion_type;
ALTER TABLE daily_challenge_completions
  ADD CONSTRAINT chk_daily_completion_type
  CHECK (challenge_type IN (
    'moneyDrop', 'trueFalse', 'clues', 'countdown', 'putInOrder',
    'imposter', 'careerPath', 'highLow', 'footballLogic', 'fifaCards', 'missingXi', 'passChain'
  )) NOT VALID;

-- The player universe the chain may pass through: every typed link is resolved
-- and validated server-side against this table, so the graph never ships to clients.
CREATE TABLE IF NOT EXISTS pass_chain_players (
  id uuid PRIMARY KEY,
  tm_id integer NOT NULL UNIQUE,
  name jsonb NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  normalized_aliases text[] NOT NULL DEFAULT '{}',
  clubs jsonb NOT NULL DEFAULT '[]',
  -- coaches the player appeared under (≥5 games): a second link kind besides shared clubs
  managers jsonb NOT NULL DEFAULT '[]',
  image_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pass_chain_players_normalized_aliases ON pass_chain_players USING gin (normalized_aliases);
