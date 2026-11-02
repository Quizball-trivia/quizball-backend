-- The daily grid's "that was right" reports join wordgame_reports (a name the grid refused that the player says fits
-- both clues of the square). Added NOT VALID, validated in 20261103230010, swapped for the old check in its own
-- migration (one table per migration, see 20261008120100).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_wordgame_reports_game_v4' AND conrelid = 'public.wordgame_reports'::regclass) THEN
    ALTER TABLE public.wordgame_reports ADD CONSTRAINT chk_wordgame_reports_game_v4 CHECK (game IN ('shared_player', 'name_chain', 'tenable', 'darts501', 'grid_daily')) NOT VALID;
  END IF;
END $$;
