-- A game's own copy of its series' settings, so loading a match needs no second table. NULL is the standard game:
-- 40 seconds a turn, typed answers.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.football_grid_matches ADD COLUMN IF NOT EXISTS settings jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'football_grid_matches_settings_check' AND conrelid = 'public.football_grid_matches'::regclass) THEN
    ALTER TABLE public.football_grid_matches
      ADD CONSTRAINT football_grid_matches_settings_check CHECK (settings IS NULL OR jsonb_typeof(settings) = 'object') NOT VALID;
  END IF;
END $$;
