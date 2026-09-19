-- Reconcile an existing staging index with one bounded online statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_questions_cms_search_trgm ON public.questions USING gin ((((((COALESCE((prompt)::text, ''::text) || ' '::text) || COALESCE((explanation)::text, ''::text)) || ' '::text) || COALESCE(type, ''::text))) gin_trgm_ops);
