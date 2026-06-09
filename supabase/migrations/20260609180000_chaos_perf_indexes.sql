-- Performance indexes derived from the 2026-06-09 chaos load test (staging,
-- 30 rps/route). See scripts/chaos/FINDINGS.md for the EXPLAIN evidence.
--
-- These are the safe, additive index wins. The larger wins (splitting
-- COUNT(*) OVER() out of the categories/questions page queries) are code
-- changes handled separately in the repos.

-- ── featured_categories: chaos EXPLAIN showed a Seq Scan on this table for the
--    featured list (join to categories + ORDER BY sort_order). Small today, but
--    the public homepage hits it on every load. ─────────────────────────────
CREATE INDEX IF NOT EXISTS idx_featured_categories_sort_order
  ON public.featured_categories (sort_order);

CREATE INDEX IF NOT EXISTS idx_featured_categories_category_id
  ON public.featured_categories (category_id);

-- ── categories.min_questions filter: the per-category correlated subquery scans
--    each category's published mcq_single questions and JSONB-validates them.
--    A partial index narrows the inner scan to exactly the rows the subquery
--    cares about (published single-MCQ), shrinking the Nested Loop. It does NOT
--    remove the per-category fan-out — a precomputed valid_mcq_count column is
--    the real fix — but it measurably cuts the inner cost with zero code change.
CREATE INDEX IF NOT EXISTS idx_questions_category_published_mcq
  ON public.questions (category_id)
  WHERE status = 'published' AND type = 'mcq_single';
