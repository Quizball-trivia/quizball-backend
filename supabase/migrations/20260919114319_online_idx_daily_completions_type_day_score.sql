-- Build on the shared table without holding a write-blocking table lock.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_daily_completions_type_day_score
  ON daily_challenge_completions (challenge_type, challenge_day, score DESC);
