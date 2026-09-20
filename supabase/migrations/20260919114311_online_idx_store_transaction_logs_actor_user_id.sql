-- One online index per file; keep ledger writes outside the index statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_store_transaction_logs_actor_user_id
  ON public.store_transaction_logs (actor_user_id)
  WHERE actor_user_id IS NOT NULL;
