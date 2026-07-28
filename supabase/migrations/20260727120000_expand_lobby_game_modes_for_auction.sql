ALTER TABLE public.lobbies
  DROP CONSTRAINT IF EXISTS lobbies_game_mode_check;

ALTER TABLE public.lobbies
  ADD CONSTRAINT lobbies_game_mode_check
  CHECK (game_mode IN ('friendly_possession', 'friendly_party_quiz', 'auction', 'ranked_sim'));
