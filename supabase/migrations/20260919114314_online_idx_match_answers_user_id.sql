-- One online index per file; keep ledger writes outside the index statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_match_answers_user_id
  ON public.match_answers (user_id);
