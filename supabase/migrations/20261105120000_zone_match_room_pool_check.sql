-- Zone match (Ranked 2.0 beta) joins the room games: room_pool (its private number-question pool), room_matches and
-- lobbies. One table per migration (see 20261008120100). Added NOT VALID, validated in 20261105120030, swapped for the old check
-- in its own migration. These run after Football Darts 501's (20261028120100…180, check v8).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_room_pool_game_v9' AND conrelid = 'public.room_pool'::regclass) THEN
    ALTER TABLE public.room_pool ADD CONSTRAINT chk_room_pool_game_v9 CHECK (game IN ('aproximado', 'shared_player', 'name_chain', 'tenable', 'football_race', 'codenames', 'dato_falso', 'conexiones', 'darts501', 'zone_match')) NOT VALID;
  END IF;
END $$;
