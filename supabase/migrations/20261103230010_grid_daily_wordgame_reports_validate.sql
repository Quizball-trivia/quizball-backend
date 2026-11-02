SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '600s';

-- Validated after the ADD CONSTRAINT transaction has committed (SHARE UPDATE EXCLUSIVE: reads and writes go on), and
-- only while the check still has its new name (a database where the swap already ran has nothing left to validate).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_wordgame_reports_game_v4' AND conrelid = 'public.wordgame_reports'::regclass AND NOT convalidated) THEN
    ALTER TABLE public.wordgame_reports VALIDATE CONSTRAINT chk_wordgame_reports_game_v4;
  END IF;
END $$;
