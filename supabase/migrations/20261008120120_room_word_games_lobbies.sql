-- Room word games, lobbies only (see 20261008120100: one table per migration). Metadata-only changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- {scope, difficulty} for the games that have them; NULL for every other room.
ALTER TABLE public.lobbies ADD COLUMN IF NOT EXISTS room_options jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lobbies_room_game_check_v2' AND conrelid = 'public.lobbies'::regclass) THEN
    -- NULL-safe as before: a room-game room always names its game; no other room has one.
    ALTER TABLE public.lobbies
      ADD CONSTRAINT lobbies_room_game_check_v2 CHECK (
        (game_mode IS DISTINCT FROM 'room_game' AND room_game IS NULL)
        OR (game_mode IS NOT DISTINCT FROM 'room_game' AND room_game IS NOT NULL AND room_game IN ('aproximado', 'shared_player', 'name_chain'))
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lobbies_room_options_check' AND conrelid = 'public.lobbies'::regclass) THEN
    ALTER TABLE public.lobbies
      -- Shape only. Not tied to the game mode: a replica of the previous release changes a room's mode without knowing
      -- this column, and must not be refused; options left behind are ignored (each game validates its own at the start).
      ADD CONSTRAINT lobbies_room_options_check CHECK (room_options IS NULL OR jsonb_typeof(room_options) = 'object') NOT VALID;
  END IF;
END $$;
