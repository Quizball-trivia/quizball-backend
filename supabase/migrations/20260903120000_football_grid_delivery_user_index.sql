-- migrate:no-transaction
-- flushPendingGridResultsOnConnect runs on every socket connect; its lookup
-- (user_id, status <> 'delivered', newest first) had no supporting index —
-- the existing partial index leads with status under a non-equality predicate.
-- Built CONCURRENTLY: the table is the terminal-result outbox written on every
-- match completion, so a blocking build would stall live result delivery.
CREATE INDEX CONCURRENTLY IF NOT EXISTS football_grid_result_deliveries_user_pending_idx
  ON public.football_grid_result_deliveries (user_id, created_at DESC)
  WHERE status <> 'delivered';
