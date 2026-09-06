-- Card Detective daily challenge: same fifa_cards pool as FIFA Cards, its own
-- per-day schedule table (own rotation history), coins-left outcomes.

-- Widen the challenge_type CHECKs as NOT VALID (instant); the next migration
-- validates them outside a transaction, mirroring 20260902100000/100050.
ALTER TABLE daily_challenge_configs
  DROP CONSTRAINT IF EXISTS chk_daily_challenge_type;
ALTER TABLE daily_challenge_configs
  ADD CONSTRAINT chk_daily_challenge_type
  CHECK (challenge_type IN (
    'moneyDrop', 'trueFalse', 'clues', 'countdown', 'putInOrder',
    'imposter', 'careerPath', 'highLow', 'footballLogic', 'fifaCards', 'cardDetective'
  )) NOT VALID;

ALTER TABLE daily_challenge_completions
  DROP CONSTRAINT IF EXISTS chk_daily_completion_type;
ALTER TABLE daily_challenge_completions
  ADD CONSTRAINT chk_daily_completion_type
  CHECK (challenge_type IN (
    'moneyDrop', 'trueFalse', 'clues', 'countdown', 'putInOrder',
    'imposter', 'careerPath', 'highLow', 'footballLogic', 'fifaCards', 'cardDetective'
  )) NOT VALID;

-- One row per UTC challenge day: the cards everyone investigates. Kept apart
-- from daily_fifa_card_sets so each game rotates through the pool on its own
-- clock; the allocator excludes players already in the other game's set for
-- the same day.
CREATE TABLE IF NOT EXISTS daily_card_detective_sets (
  challenge_day DATE PRIMARY KEY,
  card_ids UUID[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_daily_card_detective_sets_size CHECK (cardinality(card_ids) BETWEEN 1 AND 10)
);
ALTER TABLE daily_card_detective_sets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.daily_card_detective_sets FROM anon, authenticated;

-- Detective reveals up to 12 clues per card and scores by clue coins left.
-- FIFA Cards outcomes keep NULL coins_left (their score is per solve).
ALTER TABLE daily_challenge_card_outcomes
  DROP CONSTRAINT IF EXISTS chk_daily_challenge_card_outcome_clues;
ALTER TABLE daily_challenge_card_outcomes
  ADD CONSTRAINT chk_daily_challenge_card_outcome_clues
  CHECK (clues_revealed BETWEEN 0 AND 12) NOT VALID;
ALTER TABLE daily_challenge_card_outcomes
  ADD COLUMN IF NOT EXISTS coins_left SMALLINT;
ALTER TABLE daily_challenge_card_outcomes
  DROP CONSTRAINT IF EXISTS chk_daily_challenge_card_outcome_coins;
ALTER TABLE daily_challenge_card_outcomes
  ADD CONSTRAINT chk_daily_challenge_card_outcome_coins
  CHECK (coins_left IS NULL OR coins_left BETWEEN 0 AND 100) NOT VALID;

-- Seeded INACTIVE: activation is a data step once the schedule is preallocated
-- and the web client that renders the type is deployed.
INSERT INTO daily_challenge_configs (
  challenge_type, is_active, sort_order, show_on_home, coin_reward, xp_reward, settings
)
VALUES (
  'cardDetective', false, 11, false, 100, 40,
  jsonb_build_object('challengeType', 'cardDetective', 'cardCount', 10)
)
ON CONFLICT (challenge_type) DO NOTHING;
