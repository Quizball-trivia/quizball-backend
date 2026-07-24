-- The question bank already has an index on (category_id, status), and nearly
-- every question is ranked-eligible. A second partial index over the same rows
-- adds little selectivity while taking too long to build on the live table.
--
-- A timed-out CREATE INDEX CONCURRENTLY can leave an invalid index behind, so
-- remove that artefact before recording this migration as complete.
DROP INDEX CONCURRENTLY IF EXISTS public.idx_questions_ranked_eligible;
