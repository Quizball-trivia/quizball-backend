-- migrate:no-transaction
-- Board selection joins releases by status and filters by theme; the theme
-- index led with release_id, which that query never constrains directly.
CREATE INDEX CONCURRENTLY IF NOT EXISTS football_grid_boards_theme_release_idx
  ON public.football_grid_boards (theme, release_id, difficulty);
