SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- The validated check that allows 'fake-fact' replaces the old one and takes its name (metadata only).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_partner_games_game_v2' AND conrelid = 'public.partner_games'::regclass) THEN
    ALTER TABLE public.partner_games DROP CONSTRAINT IF EXISTS chk_partner_games_game;
    ALTER TABLE public.partner_games RENAME CONSTRAINT chk_partner_games_game_v2 TO chk_partner_games_game;
  END IF;
END $$;
