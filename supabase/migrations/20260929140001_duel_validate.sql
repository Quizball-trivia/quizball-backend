SET LOCAL lock_timeout = '5s';

-- Validate after the ADD CONSTRAINT transaction has committed, so the table scan does not run while
-- that migration's ACCESS EXCLUSIVE lock is held (same pattern as 20260820073705).
ALTER TABLE public.lobbies VALIDATE CONSTRAINT lobbies_game_mode_check_v3;
ALTER TABLE public.lobbies VALIDATE CONSTRAINT lobbies_duel_game_check;
ALTER TABLE public.lobbies DROP CONSTRAINT IF EXISTS lobbies_game_mode_check;
ALTER TABLE public.lobbies RENAME CONSTRAINT lobbies_game_mode_check_v3 TO lobbies_game_mode_check;
