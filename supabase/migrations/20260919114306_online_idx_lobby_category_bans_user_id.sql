-- One online index per file; keep ledger writes outside the index statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lobby_category_bans_user_id
  ON public.lobby_category_bans (user_id);
