-- Reconcile an existing staging index with one bounded online statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_questions_fk_eligible ON public.questions USING btree (id) WHERE ((status = 'published'::text) AND (type = 'mcq_single'::text) AND (ranked_eligible = true) AND (visibility = 'public'::text));
