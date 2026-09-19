-- One online index per file; keep ledger writes outside the index statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_nickname_trgm
  ON public.users USING gin (nickname gin_trgm_ops)
  WHERE is_ai = false
    AND is_deleted = false
    AND deleted_at IS NULL
    AND pending_deletion_at IS NULL
    AND nickname IS NOT NULL;
