-- A league's weekly board: each member's best finished ranked run. Standalone online index: no write-blocking build on
-- draft_free_runs.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_draft_free_runs_board ON public.draft_free_runs (league_id, week, score DESC, completed_at) WHERE ranked AND done;
