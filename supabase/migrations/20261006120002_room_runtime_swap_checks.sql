SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- The validated v4 check replaces the old mode check (which rejects 'room_game'). Metadata-only: no scan.
ALTER TABLE public.lobbies DROP CONSTRAINT IF EXISTS lobbies_game_mode_check;
ALTER TABLE public.lobbies RENAME CONSTRAINT lobbies_game_mode_check_v4 TO lobbies_game_mode_check;
