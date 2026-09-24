-- Keep report writes available while building the review queue index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS football_grid_reports_review_queue_idx
  ON public.football_grid_missing_answer_reports (status, created_at DESC);
