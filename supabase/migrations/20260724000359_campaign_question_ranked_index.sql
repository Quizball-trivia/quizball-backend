-- Build the partial index separately so writes to the existing question bank
-- remain available while the production index is created.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_questions_ranked_eligible
  ON public.questions (category_id, status, ranked_eligible)
  WHERE ranked_eligible = TRUE;
