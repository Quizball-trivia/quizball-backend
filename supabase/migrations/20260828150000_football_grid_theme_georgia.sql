-- Georgia joins the pack lineup (roster expansion 2026-08-28).
ALTER TABLE public.football_grid_boards DROP CONSTRAINT IF EXISTS football_grid_boards_theme_check;
ALTER TABLE public.football_grid_boards ADD CONSTRAINT football_grid_boards_theme_check CHECK (theme IN (
  'european', 'england', 'italy', 'spain', 'france', 'germany', 'georgia',
  'netherlands', 'brazil', 'turkey', 'argentina'
));
ALTER TABLE public.football_grid_matches DROP CONSTRAINT IF EXISTS football_grid_matches_theme_check;
ALTER TABLE public.football_grid_matches ADD CONSTRAINT football_grid_matches_theme_check CHECK (theme IN (
  'european', 'england', 'italy', 'spain', 'france', 'germany', 'georgia',
  'netherlands', 'brazil', 'turkey', 'argentina'
));
