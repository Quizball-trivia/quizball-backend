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
CREATE INDEX CONCURRENTLY IF NOT EXISTS matches_id_started_at_not_dev_idx
  ON public.matches (id) INCLUDE (started_at)
  WHERE is_dev = false;
