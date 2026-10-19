-- Football Codenames joins the room games, room_pool only (one table per migration, see 20261008120100). Added NOT
-- VALID, validated in 20261019120140, swapped for the old check in its own migration. These run after Football
-- Horserace's (20261017120100…160, check v4), which must reach an environment first.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_room_pool_game_v5' AND conrelid = 'public.room_pool'::regclass) THEN
    ALTER TABLE public.room_pool ADD CONSTRAINT chk_room_pool_game_v5 CHECK (game IN ('aproximado', 'shared_player', 'name_chain', 'tenable', 'football_race', 'codenames')) NOT VALID;
  END IF;
END $$;
