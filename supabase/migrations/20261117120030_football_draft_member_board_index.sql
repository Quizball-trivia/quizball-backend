-- One member's best of a league's week (the board's "me" row and the leagues screen). Standalone online index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_draft_free_runs_member_board ON public.draft_free_runs (user_id, week, league_id, score DESC) WHERE ranked AND done;
