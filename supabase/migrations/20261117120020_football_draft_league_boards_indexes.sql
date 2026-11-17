SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- A league's weekly board, and one member's best on it. Only ranked, finished runs: new rows, so these start small.
CREATE INDEX IF NOT EXISTS idx_draft_free_runs_board ON public.draft_free_runs (league_id, week, score DESC, completed_at) WHERE ranked AND done;
CREATE INDEX IF NOT EXISTS idx_draft_free_runs_member_board ON public.draft_free_runs (user_id, week, league_id, score DESC) WHERE ranked AND done;
