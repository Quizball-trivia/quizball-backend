-- migrate:no-transaction
-- This must remain a standalone statement: PostgreSQL does not allow
-- CREATE INDEX CONCURRENTLY inside an explicit or implicit transaction block.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_question_payloads_cms_search_trgm
  ON public.question_payloads USING gin ((COALESCE(payload::text, '')) gin_trgm_ops);
