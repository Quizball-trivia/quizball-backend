-- migrate:no-transaction
-- Question search is an admin CMS substring search over localized JSONB text,
-- question type, and payload content. B-tree indexes cannot serve ILIKE
-- '%term%'; trigram GIN indexes can (for the API's enforced 3+ character terms).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_questions_cms_search_trgm
  ON public.questions USING gin ((
    COALESCE(prompt::text, '') || ' ' ||
    COALESCE(explanation::text, '') || ' ' ||
    COALESCE(type, '')
  ) gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_question_payloads_cms_search_trgm
  ON public.question_payloads USING gin ((COALESCE(payload::text, '')) gin_trgm_ops);
