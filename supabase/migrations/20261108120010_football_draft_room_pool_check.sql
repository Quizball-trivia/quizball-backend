-- Football Draft joins the room games: room_pool, room_matches and
-- lobbies. One table per migration (see 20261008120100). Added NOT VALID, validated in 20261108120100, swapped for the old check
-- in its own migration. These run after Zone match's (20261105120000…060, check v9).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_room_pool_game_v10' AND conrelid = 'public.room_pool'::regclass) THEN
    ALTER TABLE public.room_pool ADD CONSTRAINT chk_room_pool_game_v10 CHECK (game IN ('aproximado', 'shared_player', 'name_chain', 'tenable', 'football_race', 'codenames', 'dato_falso', 'conexiones', 'darts501', 'zone_match', 'draft')) NOT VALID;
  END IF;
END $$;
