-- One statement: the deploy runner executes concurrent indexes without BEGIN.
-- Completion analytics reads attempts for each match participant. The retention
-- index cannot serve this lookup, so each result/retry currently scans all attempts.
CREATE INDEX CONCURRENTLY IF NOT EXISTS football_grid_attempts_match_actor_idx
  ON public.football_grid_attempts (match_id, actor_user_id);
