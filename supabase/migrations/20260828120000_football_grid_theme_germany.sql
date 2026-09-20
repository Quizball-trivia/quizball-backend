-- Germany joins the league-pack lineup (4 Bundesliga clubs already have
-- verified criteria/memberships). Constraint recreated with the new value.
ALTER TABLE public.football_grid_boards DROP CONSTRAINT IF EXISTS football_grid_boards_theme_check;
ALTER TABLE public.football_grid_boards ADD CONSTRAINT football_grid_boards_theme_check CHECK (theme IN (
  'european', 'england', 'italy', 'spain', 'france', 'germany',
  'netherlands', 'brazil', 'turkey', 'argentina'
));
ALTER TABLE public.football_grid_matches DROP CONSTRAINT IF EXISTS football_grid_matches_theme_check;
ALTER TABLE public.football_grid_matches ADD CONSTRAINT football_grid_matches_theme_check CHECK (theme IN (
  'european', 'england', 'italy', 'spain', 'france', 'germany',
  'netherlands', 'brazil', 'turkey', 'argentina'
));
