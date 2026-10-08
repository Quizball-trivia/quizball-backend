SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- The validated checks that allow the two new room games replace the old ones, and take their names (metadata only).
ALTER TABLE public.lobbies DROP CONSTRAINT IF EXISTS lobbies_room_game_check;
ALTER TABLE public.room_pool DROP CONSTRAINT IF EXISTS chk_room_pool_game;
ALTER TABLE public.room_matches DROP CONSTRAINT IF EXISTS chk_room_matches_game;
ALTER TABLE public.lobbies RENAME CONSTRAINT lobbies_room_game_check_v2 TO lobbies_room_game_check;
ALTER TABLE public.room_pool RENAME CONSTRAINT chk_room_pool_game_v2 TO chk_room_pool_game;
ALTER TABLE public.room_matches RENAME CONSTRAINT chk_room_matches_game_v2 TO chk_room_matches_game;
