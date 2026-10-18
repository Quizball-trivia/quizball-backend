SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- The validated check that allows Football Codenames replaces the old one and takes its name (metadata only).
-- One table per migration (see 20261008120100).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_room_pool_game_v5' AND conrelid = 'public.room_pool'::regclass) THEN
    ALTER TABLE public.room_pool DROP CONSTRAINT IF EXISTS chk_room_pool_game;
    -- A chk_room_pool_game_v4 left by Football Horserace's migrations (if they ran without their swap) goes too.
    ALTER TABLE public.room_pool DROP CONSTRAINT IF EXISTS chk_room_pool_game_v4;
    ALTER TABLE public.room_pool RENAME CONSTRAINT chk_room_pool_game_v5 TO chk_room_pool_game;
  END IF;
END $$;
