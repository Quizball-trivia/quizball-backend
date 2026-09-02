-- FIFA Cards ("Guess the Card") daily challenge: card pool, per-day set, per-card outcomes.

CREATE TABLE IF NOT EXISTS fifa_cards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Durable identity for idempotent re-imports (sofifa:<edition>:<player id>, or sofifa:<edition>-<name slug>).
  source_key TEXT NOT NULL UNIQUE,
  edition TEXT NOT NULL,
  edition_label TEXT NOT NULL,
  name TEXT NOT NULL,
  name_ka TEXT,
  accepted TEXT[] NOT NULL,
  overall SMALLINT NOT NULL,
  position TEXT NOT NULL,
  nation TEXT NOT NULL,
  nation_code TEXT NOT NULL DEFAULT '',
  league TEXT NOT NULL DEFAULT '',
  club TEXT NOT NULL,
  pac SMALLINT NOT NULL, sho SMALLINT NOT NULL, pas SMALLINT NOT NULL,
  dri SMALLINT NOT NULL, def SMALLINT NOT NULL, phy SMALLINT NOT NULL,
  photo_id INTEGER,
  photo_ver TEXT,
  -- own = face id came with the card's own edition row; name-match = borrowed from another edition; none = silhouette.
  face_source TEXT NOT NULL DEFAULT 'none',
  difficulty TEXT NOT NULL DEFAULT 'medium',
  is_active BOOLEAN NOT NULL DEFAULT true,
  -- true when the generator import retired this card (it fell out of the
  -- dataset); a later import that brings it back re-activates it. Manual
  -- deactivations (false here) are never touched by imports.
  generator_retired BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_fifa_cards_face_source CHECK (face_source IN ('own', 'name-match', 'none')),
  CONSTRAINT chk_fifa_cards_difficulty CHECK (difficulty IN ('easy', 'medium', 'hard')),
  CONSTRAINT chk_fifa_cards_overall CHECK (overall BETWEEN 40 AND 99)
);

CREATE INDEX IF NOT EXISTS idx_fifa_cards_active ON fifa_cards (is_active) WHERE is_active;

CREATE TRIGGER trg_fifa_cards_updated_at
  BEFORE UPDATE ON fifa_cards
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- One row per UTC challenge day: the 10 cards everyone plays. Materialised on
-- first request of the day; unseen-first rotation means no card repeats until
-- the active pool has cycled. Admins may edit a future day's row by hand.
CREATE TABLE IF NOT EXISTS daily_fifa_card_sets (
  challenge_day DATE PRIMARY KEY,
  card_ids UUID[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_daily_fifa_card_sets_size CHECK (cardinality(card_ids) BETWEEN 1 AND 10)
);

-- Per-card result of a completed round, validated against that day's set.
CREATE TABLE IF NOT EXISTS daily_challenge_card_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  completion_id UUID NOT NULL REFERENCES daily_challenge_completions(id) ON DELETE CASCADE,
  card_id UUID NOT NULL REFERENCES fifa_cards(id) ON DELETE CASCADE,
  solved BOOLEAN NOT NULL,
  clues_revealed SMALLINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_daily_challenge_card_outcome UNIQUE (completion_id, card_id),
  CONSTRAINT chk_daily_challenge_card_outcome_clues CHECK (clues_revealed BETWEEN 0 AND 3)
);

CREATE INDEX IF NOT EXISTS idx_daily_challenge_card_outcomes_card ON daily_challenge_card_outcomes (card_id);

-- Backend-only tables: the API reaches them through its own DB role; nothing
-- should be readable through the Data API (RLS on, no policies, browser roles revoked).
ALTER TABLE fifa_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_fifa_card_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_challenge_card_outcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fifa_cards FROM anon, authenticated;
REVOKE ALL ON TABLE public.daily_fifa_card_sets FROM anon, authenticated;
REVOKE ALL ON TABLE public.daily_challenge_card_outcomes FROM anon, authenticated;

-- Expand the challenge_type CHECKs as NOT VALID here (instant, no table scan);
-- the next migration validates them outside a transaction so the scan holds
-- only SHARE UPDATE EXCLUSIVE and never blocks live completions.
ALTER TABLE daily_challenge_configs
  DROP CONSTRAINT IF EXISTS chk_daily_challenge_type;
ALTER TABLE daily_challenge_configs
  ADD CONSTRAINT chk_daily_challenge_type
  CHECK (challenge_type IN (
    'moneyDrop', 'trueFalse', 'clues', 'countdown', 'putInOrder',
    'imposter', 'careerPath', 'highLow', 'footballLogic', 'fifaCards'
  )) NOT VALID;

ALTER TABLE daily_challenge_completions
  DROP CONSTRAINT IF EXISTS chk_daily_completion_type;
ALTER TABLE daily_challenge_completions
  ADD CONSTRAINT chk_daily_completion_type
  CHECK (challenge_type IN (
    'moneyDrop', 'trueFalse', 'clues', 'countdown', 'putInOrder',
    'imposter', 'careerPath', 'highLow', 'footballLogic', 'fifaCards'
  )) NOT VALID;

-- Seeded INACTIVE: the tile appears only once the card pool is populated and
-- an operator flips is_active (data step, see runbook).
INSERT INTO daily_challenge_configs (
  challenge_type, is_active, sort_order, show_on_home, coin_reward, xp_reward, settings
)
VALUES (
  'fifaCards', false, 10, false, 100, 40,
  jsonb_build_object('challengeType', 'fifaCards', 'cardCount', 10)
)
ON CONFLICT (challenge_type) DO NOTHING;
