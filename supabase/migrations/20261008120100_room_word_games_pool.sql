-- Two more room games (2–6 players): 'shared_player' (played for both) and 'name_chain'. The three checks that name
-- the room games gain them in three steps: added NOT VALID, validated, then swapped for the old ones.
-- ONE TABLE PER MIGRATION (each is its own transaction): a start locks its room and then inserts the match, a finishing
-- match locks the match and then its room, so a migration holding two of these tables could deadlock with either.
--
-- This one: the pool. Tags on pool items, so a match can be dealt from one scope (a league, a difficulty mix).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.room_pool ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_room_pool_tags ON public.room_pool USING gin (tags) WHERE enabled;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname IN ('chk_room_pool_game_v2') AND conrelid = 'public.room_pool'::regclass) THEN
    ALTER TABLE public.room_pool ADD CONSTRAINT chk_room_pool_game_v2 CHECK (game IN ('aproximado', 'shared_player', 'name_chain')) NOT VALID;
  END IF;
END $$;
