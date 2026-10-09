SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- The validated check that allows the two new room games replaces the old one and takes its name (metadata only).
-- One table per migration (see 20261008120100).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lobbies_room_game_check_v2' AND conrelid = 'public.lobbies'::regclass) THEN
    ALTER TABLE public.lobbies DROP CONSTRAINT IF EXISTS lobbies_room_game_check;
    ALTER TABLE public.lobbies RENAME CONSTRAINT lobbies_room_game_check_v2 TO lobbies_room_game_check;
  END IF;
END $$;
