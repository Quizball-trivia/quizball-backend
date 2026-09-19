-- One online index per file; keep ledger writes outside the index statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_matches_winner_user_id
  ON public.matches (winner_user_id)
  WHERE winner_user_id IS NOT NULL;
