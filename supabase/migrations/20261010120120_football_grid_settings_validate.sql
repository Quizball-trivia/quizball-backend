SET LOCAL lock_timeout = '5s';

ALTER TABLE public.football_grid_series VALIDATE CONSTRAINT football_grid_series_format_check_v2;
ALTER TABLE public.football_grid_series VALIDATE CONSTRAINT football_grid_series_settings_check;
ALTER TABLE public.football_grid_matches VALIDATE CONSTRAINT football_grid_matches_settings_check;
