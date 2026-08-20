-- The question selector needs ordered access by difficulty and UUID. Build the
-- partial accelerator through the session pooler so the database role's
-- per-statement transaction-pooler timeout cannot cancel the online build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_questions_road_to_goal_eligible
  ON public.questions (difficulty, id)
  WHERE status = 'published'
    AND type = 'mcq_single'
    AND ranked_eligible = true
    AND visibility = 'public';
