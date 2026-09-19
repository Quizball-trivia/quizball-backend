-- One online index per file; keep ledger writes outside the index statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lobbies_host_user_id
  ON public.lobbies (host_user_id);
