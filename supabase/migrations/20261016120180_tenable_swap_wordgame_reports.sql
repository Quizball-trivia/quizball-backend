SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- The validated check that allows Tenable replaces the old one and takes its name (metadata only). One table per
-- migration (see 20261008120100).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_wordgame_reports_game_v2' AND conrelid = 'public.wordgame_reports'::regclass) THEN
    ALTER TABLE public.wordgame_reports DROP CONSTRAINT IF EXISTS chk_wordgame_reports_game;
    ALTER TABLE public.wordgame_reports RENAME CONSTRAINT chk_wordgame_reports_game_v2 TO chk_wordgame_reports_game;
  END IF;
END $$;
