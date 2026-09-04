-- migrate:no-transaction
-- The retention-email worker aggregates users x match_players x matches every
-- 60s. Its join reads only `started_at` and filters `is_dev`, but had to visit
-- the 408 MB `matches` heap for each row: prod EXPLAIN showed an Index Scan on
-- matches_pkey with loops=148,629 and 594,521 shared buffer hits (~4.6 GB of
-- pages) per run, at 827.9 ms mean.
--
-- INCLUDE (started_at) makes it an Index Only Scan, so the heap is not touched.
-- Red/green on a local reproduction at prod scale (18,388 users / 124,315
-- matches / 248,630 match_players, prod plan shape forced): 124.2 ms -> 72.2 ms
-- (-42%), 558,887 -> 499,953 buffers.
--
-- This is the secondary fix. The primary one is not running the scan on every
-- tick (see retention-email.worker.ts) — the daily assignment cap is reached
-- every day, so most ticks scanned and discarded the result.
-- A failed CREATE INDEX CONCURRENTLY leaves the index behind marked invalid.
-- CREATE INDEX ... IF NOT EXISTS would then skip it on the next deploy and the
-- runner would record this migration as applied, leaving an index that is never
-- used for reads but still maintained on every write. Drop that carcass first so
-- the retry actually rebuilds. Plain DROP INDEX, not CONCURRENTLY: the latter
-- cannot run from inside a function body (verified against staging:
-- "DROP INDEX CONCURRENTLY cannot be executed from a function"), and an invalid
-- index serves no reads, so the brief lock has nothing to block.
DO $$
DECLARE
  invalid_index regclass;
BEGIN
  SELECT c.oid INTO invalid_index
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_index i ON i.indexrelid = c.oid
  WHERE c.relname = 'matches_id_started_at_not_dev_idx'
    AND n.nspname = 'public'
    AND NOT i.indisvalid;
  IF invalid_index IS NOT NULL THEN
    RAISE NOTICE 'Dropping invalid index %', invalid_index;
    EXECUTE format('DROP INDEX %s', invalid_index);
  END IF;
END $$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS matches_id_started_at_not_dev_idx
  ON public.matches (id) INCLUDE (started_at)
  WHERE is_dev = false;
