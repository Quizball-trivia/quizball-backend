-- Difficulty-stratified random UUID pivot scans use this partial index. The
-- exact eligibility predicate is shared with ranked/free-kicks question pools.
-- CONCURRENTLY requires this migration to contain one statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_questions_road_to_goal_eligible
  ON public.questions (difficulty, id)
  WHERE status = 'published'
    AND type = 'mcq_single'
    AND ranked_eligible = true
    AND visibility = 'public';
