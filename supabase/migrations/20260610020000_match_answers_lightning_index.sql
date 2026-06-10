-- Perf (db-optimize.md #4 remainder): the achievements metrics query
-- (achievements.repo.ts getMetricsForUser) checks "has any correct answer
-- faster than 2s" with an EXISTS over match_answers filtered only by user_id.
-- match_answers has no user_id index, so every call seq-scanned the table
-- (prod: 140ms mean x 13.6k calls; staging EXPLAIN: 23ms -> 0.095ms with this
-- index, index-only scan).
--
-- Partial index matches the hardcoded predicate (is_correct = true AND
-- time_ms <= 2000) so it stays tiny and adds near-zero write cost.
-- Applied + EXPLAIN-verified on staging 2026-06-10 before commit.
CREATE INDEX IF NOT EXISTS idx_match_answers_user_lightning
  ON match_answers (user_id)
  WHERE is_correct = true AND time_ms <= 2000;
