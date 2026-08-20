-- A canceled online index build leaves an invalid relation that
-- IF NOT EXISTS will skip. Drop either state online before recreating the
-- canonical idempotency guard in the next migration.
DROP INDEX CONCURRENTLY IF EXISTS public.uq_store_tx_road_to_goal_idempotency;
