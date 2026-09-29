SET LOCAL lock_timeout = '5s';

-- Validate after the ADD CONSTRAINT transaction has committed, so the table scans do not run while that
-- migration's ACCESS EXCLUSIVE locks are held (the pattern of 20260929140001). Only then drop the old checks that
-- still refuse 'ultimo', and take their names.
ALTER TABLE public.lobbies VALIDATE CONSTRAINT lobbies_duel_game_check_v2;
ALTER TABLE public.duel_pool VALIDATE CONSTRAINT chk_duel_pool_game_v2;
ALTER TABLE public.duel_matches VALIDATE CONSTRAINT chk_duel_matches_game_v2;
ALTER TABLE public.lobbies DROP CONSTRAINT IF EXISTS lobbies_duel_game_check;
ALTER TABLE public.duel_pool DROP CONSTRAINT IF EXISTS chk_duel_pool_game;
ALTER TABLE public.duel_matches DROP CONSTRAINT IF EXISTS chk_duel_matches_game;
ALTER TABLE public.lobbies RENAME CONSTRAINT lobbies_duel_game_check_v2 TO lobbies_duel_game_check;
ALTER TABLE public.duel_pool RENAME CONSTRAINT chk_duel_pool_game_v2 TO chk_duel_pool_game;
ALTER TABLE public.duel_matches RENAME CONSTRAINT chk_duel_matches_game_v2 TO chk_duel_matches_game;
