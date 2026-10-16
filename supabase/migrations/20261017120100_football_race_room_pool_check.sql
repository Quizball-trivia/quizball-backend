-- Football Horserace joins the room games, room_pool only (one table per migration, see 20261008120100). Added NOT
-- VALID, validated in 20261017120130, swapped for the old check in its own migration. The list keeps 'tenable': these
-- run after Tenable's (20261016120100…180, check v3), and Tenable must reach an environment first, or its swap would
-- put back a check without 'football_race'.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_room_pool_game_v4' AND conrelid = 'public.room_pool'::regclass) THEN
    ALTER TABLE public.room_pool ADD CONSTRAINT chk_room_pool_game_v4 CHECK (game IN ('aproximado', 'shared_player', 'name_chain', 'tenable', 'football_race')) NOT VALID;
  END IF;
END $$;
