SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- The validated check that allows best of 5 and 7 replaces the old one and takes its name (metadata only).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'football_grid_series_format_check_v2' AND conrelid = 'public.football_grid_series'::regclass) THEN
    ALTER TABLE public.football_grid_series DROP CONSTRAINT IF EXISTS football_grid_series_format_check;
    ALTER TABLE public.football_grid_series RENAME CONSTRAINT football_grid_series_format_check_v2 TO football_grid_series_format_check;
  END IF;
END $$;
