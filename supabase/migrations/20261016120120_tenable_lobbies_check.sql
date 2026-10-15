-- Tenable joins the room games, lobbies only (one table per migration, see 20261008120100). Added NOT VALID, validated in
-- 20261016120140, swapped for the old check in its own migration.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lobbies_room_game_check_v3' AND conrelid = 'public.lobbies'::regclass) THEN
    ALTER TABLE public.lobbies ADD CONSTRAINT lobbies_room_game_check_v3 CHECK ((game_mode IS DISTINCT FROM 'room_game' AND room_game IS NULL) OR (game_mode IS NOT DISTINCT FROM 'room_game' AND room_game IS NOT NULL AND room_game IN ('aproximado', 'shared_player', 'name_chain', 'tenable'))) NOT VALID;
  END IF;
END $$;
