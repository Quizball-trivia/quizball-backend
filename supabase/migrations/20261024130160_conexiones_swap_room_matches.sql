SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- The validated check that allows Conexiones futboleras replaces the old one and takes its name (metadata only).
-- One table per migration (see 20261008120100).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_room_matches_game_v7' AND conrelid = 'public.room_matches'::regclass) THEN
    ALTER TABLE public.room_matches DROP CONSTRAINT IF EXISTS chk_room_matches_game;
    -- A chk_room_matches_game_v6 left by Dato falso's migrations (if they ran without their swap) goes too.
    ALTER TABLE public.room_matches DROP CONSTRAINT IF EXISTS chk_room_matches_game_v6;
    ALTER TABLE public.room_matches RENAME CONSTRAINT chk_room_matches_game_v7 TO chk_room_matches_game;
  END IF;
END $$;
