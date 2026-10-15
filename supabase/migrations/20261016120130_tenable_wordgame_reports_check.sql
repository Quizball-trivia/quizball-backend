-- Tenable joins the room games, wordgame_reports only (one table per migration, see 20261008120100). Added NOT VALID, validated in
-- 20261016120140, swapped for the old check in its own migration.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_wordgame_reports_game_v2' AND conrelid = 'public.wordgame_reports'::regclass) THEN
    ALTER TABLE public.wordgame_reports ADD CONSTRAINT chk_wordgame_reports_game_v2 CHECK (game IN ('shared_player', 'name_chain', 'tenable')) NOT VALID;
  END IF;
END $$;
