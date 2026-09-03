-- flushPendingGridResultsOnConnect runs on every socket connect; its lookup
-- (user_id, status <> 'delivered', newest first) had no supporting index —
-- the existing partial index leads with status under a non-equality predicate.
CREATE INDEX IF NOT EXISTS football_grid_result_deliveries_user_pending_idx
  ON public.football_grid_result_deliveries (user_id, created_at DESC)
  WHERE status <> 'delivered';

-- Board selection joins releases by status and filters by theme; the theme
-- index led with release_id, which that query never constrains directly.
CREATE INDEX IF NOT EXISTS football_grid_boards_theme_release_idx
  ON public.football_grid_boards (theme, release_id, difficulty);
