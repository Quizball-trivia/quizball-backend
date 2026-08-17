-- Per-(user, footballer) ENCOUNTER counter for the auction scout-season
-- rotation. auction_seen_cards cannot serve this purpose: it deduplicates on
-- (user_id, clue_card_id), so repeat encounters of the same card don't grow a
-- count, and per-locale card variants would double-count a single player.
-- This counter increments on every serve, is keyed by the football player (so
-- card variants and content deletions can't skew it), and never expires — the
-- rotation must only wrap after every season has been shown.
CREATE TABLE IF NOT EXISTS public.auction_scout_encounters (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  football_player_id uuid NOT NULL
    REFERENCES public.football_players(id) ON DELETE CASCADE,
  encounters int NOT NULL DEFAULT 1 CHECK (encounters > 0),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, football_player_id)
);

ALTER TABLE public.auction_scout_encounters ENABLE ROW LEVEL SECURITY;
