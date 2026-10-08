-- Two more room games (2–6 players): 'shared_player' (played for both) and 'name_chain'. The three checks that name
-- the room games gain them NOT VALID here; the next migration validates them and the one after swaps the old ones out.
-- Also: a room's options (which clubs, how hard) and tags on pool items, so a match can be dealt from one scope.
-- Both new columns are metadata-only changes.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The pool first (read only when a match starts), then room_matches, the lobbies table last: its lock is held for
-- metadata changes only, and never while waiting for a table a running match already holds.
ALTER TABLE public.room_pool ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_room_pool_tags ON public.room_pool USING gin (tags) WHERE enabled;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_room_pool_game_v2' AND conrelid = 'public.room_pool'::regclass) THEN
    ALTER TABLE public.room_pool ADD CONSTRAINT chk_room_pool_game_v2 CHECK (game IN ('aproximado', 'shared_player', 'name_chain')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_room_matches_game_v2' AND conrelid = 'public.room_matches'::regclass) THEN
    ALTER TABLE public.room_matches ADD CONSTRAINT chk_room_matches_game_v2 CHECK (game IN ('aproximado', 'shared_player', 'name_chain')) NOT VALID;
  END IF;
  -- lobbies from here on, after room_matches: the order a finishing match takes its locks in (match, then its room).
  -- {scope, difficulty} for the games that have them; NULL for every other room.
  ALTER TABLE public.lobbies ADD COLUMN IF NOT EXISTS room_options jsonb;
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
