-- A canceled online index build leaves an invalid relation that IF NOT EXISTS
-- will skip. Drop either state online before installing the dedicated Road to
-- Goal idempotency-key table in the next migration.
DROP INDEX CONCURRENTLY IF EXISTS public.uq_store_tx_road_to_goal_idempotency;
