-- Room word games, room_matches only (see 20261008120100: one table per migration).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_room_matches_game_v2' AND conrelid = 'public.room_matches'::regclass) THEN
    ALTER TABLE public.room_matches ADD CONSTRAINT chk_room_matches_game_v2 CHECK (game IN ('aproximado', 'shared_player', 'name_chain')) NOT VALID;
  END IF;
END $$;
