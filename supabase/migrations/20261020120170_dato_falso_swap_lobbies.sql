SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- The validated check that allows Dato falso futbolero replaces the old one and takes its name (metadata only).
-- One table per migration (see 20261008120100).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lobbies_room_game_check_v6' AND conrelid = 'public.lobbies'::regclass) THEN
    ALTER TABLE public.lobbies DROP CONSTRAINT IF EXISTS lobbies_room_game_check;
    -- A lobbies_room_game_check_v5 left by Football Codenames' migrations (if they ran without their swap) goes too.
    ALTER TABLE public.lobbies DROP CONSTRAINT IF EXISTS lobbies_room_game_check_v5;
    ALTER TABLE public.lobbies RENAME CONSTRAINT lobbies_room_game_check_v6 TO lobbies_room_game_check;
  END IF;
END $$;
