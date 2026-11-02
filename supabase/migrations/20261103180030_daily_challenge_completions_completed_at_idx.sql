-- migrate:no-transaction
-- Time-window reads (HQ activity rollup refresh, admin-stats actives).
CREATE INDEX CONCURRENTLY IF NOT EXISTS daily_challenge_completions_completed_at_idx
  ON public.daily_challenge_completions (completed_at);
