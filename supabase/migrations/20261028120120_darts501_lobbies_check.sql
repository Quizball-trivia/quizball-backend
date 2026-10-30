-- Football Darts 501, lobbies only (see 20261028120100). NULL-safe as before: a room-game room always names its game.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lobbies_room_game_check_v8' AND conrelid = 'public.lobbies'::regclass) THEN
    ALTER TABLE public.lobbies
      ADD CONSTRAINT lobbies_room_game_check_v8 CHECK (
        (game_mode IS DISTINCT FROM 'room_game' AND room_game IS NULL)
        OR (game_mode IS NOT DISTINCT FROM 'room_game' AND room_game IS NOT NULL AND room_game IN ('aproximado', 'shared_player', 'name_chain', 'tenable', 'football_race', 'codenames', 'dato_falso', 'conexiones', 'darts501'))
      ) NOT VALID;
  END IF;
END $$;
