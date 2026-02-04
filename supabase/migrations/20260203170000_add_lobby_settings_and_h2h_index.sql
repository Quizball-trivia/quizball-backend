-- Add lobby settings for friendly/ranked_sim setup
ALTER TABLE public.lobbies
  ADD COLUMN game_mode text NOT NULL DEFAULT 'friendly' CHECK (game_mode IN ('friendly', 'ranked_sim')),
  ADD COLUMN friendly_random boolean NOT NULL DEFAULT true,
  ADD COLUMN friendly_category_a_id uuid REFERENCES public.categories(id),
  ADD COLUMN friendly_category_b_id uuid REFERENCES public.categories(id);

-- Speed up head-to-head lookups
CREATE INDEX IF NOT EXISTS match_players_user_match_idx
  ON public.match_players(user_id, match_id);
