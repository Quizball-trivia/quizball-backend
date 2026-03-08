ALTER TABLE public.lobbies
  DROP CONSTRAINT IF EXISTS lobbies_game_mode_check;

UPDATE public.lobbies
SET game_mode = 'friendly_possession'
WHERE game_mode = 'friendly';

ALTER TABLE public.lobbies
  ALTER COLUMN game_mode SET DEFAULT 'friendly_possession';

ALTER TABLE public.lobbies
  ADD CONSTRAINT lobbies_game_mode_check
  CHECK (game_mode IN ('friendly_possession', 'friendly_party_quiz', 'ranked_sim'));
