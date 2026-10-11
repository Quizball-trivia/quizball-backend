-- Tic Tac Toe friend rooms choose their own rules: rounds (best of 3, 5 or 7), turn time, typed answers or pick
-- from four, and board difficulty. A series carries them in `settings` and hands them to each of its games. The
-- wider format check is added NOT VALID here, validated by 20261010120120 and swapped in by 20261010120130.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.football_grid_series ADD COLUMN IF NOT EXISTS settings jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'football_grid_series_format_check_v2' AND conrelid = 'public.football_grid_series'::regclass) THEN
    ALTER TABLE public.football_grid_series
      ADD CONSTRAINT football_grid_series_format_check_v2 CHECK (format IN ('single', 'bo3', 'bo5', 'bo7')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'football_grid_series_settings_check' AND conrelid = 'public.football_grid_series'::regclass) THEN
    ALTER TABLE public.football_grid_series
      ADD CONSTRAINT football_grid_series_settings_check CHECK (settings IS NULL OR jsonb_typeof(settings) = 'object') NOT VALID;
  END IF;
END $$;
