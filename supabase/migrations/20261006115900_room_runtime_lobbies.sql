-- Room games (2–6 players), part 1 of 3: the lobbies change alone. Its ACCESS EXCLUSIVE lock is held only for these
-- catalog-only statements (constraints NOT VALID, validated later), never while waiting on another hot table's lock.
-- Separate from the duel runtime on purpose (docs/ROOM-GAMES-PLAN-V2.md): duel code and tables are untouched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.lobbies ADD COLUMN IF NOT EXISTS room_game text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c WHERE c.conname = 'lobbies_game_mode_check_v4' AND c.conrelid = 'public.lobbies'::regclass
  ) THEN
    ALTER TABLE public.lobbies
      ADD CONSTRAINT lobbies_game_mode_check_v4 CHECK (
        game_mode IN ('friendly_possession', 'friendly_party_quiz', 'auction', 'ranked_sim', 'football_grid', 'duel', 'room_game')
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c WHERE c.conname = 'lobbies_room_game_check' AND c.conrelid = 'public.lobbies'::regclass
  ) THEN
    -- A room-game room always names its game; no other room has one (NULL-safe, like lobbies_duel_game_check).
    ALTER TABLE public.lobbies
      ADD CONSTRAINT lobbies_room_game_check CHECK (
        (game_mode IS DISTINCT FROM 'room_game' AND room_game IS NULL)
        OR (game_mode IS NOT DISTINCT FROM 'room_game' AND room_game IS NOT NULL AND room_game IN ('aproximado'))
      ) NOT VALID;
  END IF;
END $$;
