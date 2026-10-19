-- Dato falso futbolero joins the room games, room_pool only (one table per migration, see 20261008120100). Added NOT
-- VALID, validated in 20261020120140, swapped for the old check in its own migration. These run after Football
-- Codenames' (20261019120100…180, check v5), which must reach an environment first.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_room_pool_game_v6' AND conrelid = 'public.room_pool'::regclass) THEN
    ALTER TABLE public.room_pool ADD CONSTRAINT chk_room_pool_game_v6 CHECK (game IN ('aproximado', 'shared_player', 'name_chain', 'tenable', 'football_race', 'codenames', 'dato_falso')) NOT VALID;
  END IF;
END $$;
