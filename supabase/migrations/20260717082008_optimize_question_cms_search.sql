-- migrate:no-transaction
-- Question search is an admin CMS substring search over localized JSONB text,
-- question type, and payload content. B-tree indexes cannot serve ILIKE
-- '%term%'; trigram GIN indexes can (for the API's enforced 3+ character terms).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_questions_cms_search_trgm
  ON public.questions USING gin ((
    COALESCE(prompt::text, '') || ' ' ||
    COALESCE(explanation::text, '') || ' ' ||
    COALESCE(type, '')
  ) gin_trgm_ops);
