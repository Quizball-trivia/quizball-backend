SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- The validated check that allows the daily grid replaces the old one and takes its name (metadata only).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_wordgame_reports_game_v4' AND conrelid = 'public.wordgame_reports'::regclass) THEN
    ALTER TABLE public.wordgame_reports DROP CONSTRAINT IF EXISTS chk_wordgame_reports_game;
    -- Checks left by earlier games' migrations, if they ran without their swap, go too.
    ALTER TABLE public.wordgame_reports DROP CONSTRAINT IF EXISTS chk_wordgame_reports_game_v2;
    ALTER TABLE public.wordgame_reports DROP CONSTRAINT IF EXISTS chk_wordgame_reports_game_v3;
    ALTER TABLE public.wordgame_reports RENAME CONSTRAINT chk_wordgame_reports_game_v4 TO chk_wordgame_reports_game;
  END IF;
END $$;
