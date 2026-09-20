-- One online index per file; keep ledger writes outside the index statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ranked_profiles_archive_user_id
  ON public.ranked_profiles_archive (user_id);
