-- One online index per file; keep ledger writes outside the index statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ranked_rp_changes_archive_user_id
  ON public.ranked_rp_changes_archive (user_id);
