-- Football Darts 501's "that was right" reports, wordgame_reports only (see 20261028120100).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_wordgame_reports_game_v3' AND conrelid = 'public.wordgame_reports'::regclass) THEN
    ALTER TABLE public.wordgame_reports ADD CONSTRAINT chk_wordgame_reports_game_v3 CHECK (game IN ('shared_player', 'name_chain', 'tenable', 'darts501')) NOT VALID;
  END IF;
END $$;
