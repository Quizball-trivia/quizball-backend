-- Football Draft, room_matches only (see 20261108120010).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_room_matches_game_v10' AND conrelid = 'public.room_matches'::regclass) THEN
    ALTER TABLE public.room_matches ADD CONSTRAINT chk_room_matches_game_v10 CHECK (game IN ('aproximado', 'shared_player', 'name_chain', 'tenable', 'football_race', 'codenames', 'dato_falso', 'conexiones', 'darts501', 'zone_match', 'draft')) NOT VALID;
  END IF;
END $$;
