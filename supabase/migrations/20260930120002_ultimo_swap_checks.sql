SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- The validated checks that allow 'ultimo' replace the old ones, and take their names (metadata only).
ALTER TABLE public.lobbies DROP CONSTRAINT IF EXISTS lobbies_duel_game_check;
ALTER TABLE public.duel_pool DROP CONSTRAINT IF EXISTS chk_duel_pool_game;
ALTER TABLE public.duel_matches DROP CONSTRAINT IF EXISTS chk_duel_matches_game;
ALTER TABLE public.lobbies RENAME CONSTRAINT lobbies_duel_game_check_v2 TO lobbies_duel_game_check;
ALTER TABLE public.duel_pool RENAME CONSTRAINT chk_duel_pool_game_v2 TO chk_duel_pool_game;
ALTER TABLE public.duel_matches RENAME CONSTRAINT chk_duel_matches_game_v2 TO chk_duel_matches_game;
