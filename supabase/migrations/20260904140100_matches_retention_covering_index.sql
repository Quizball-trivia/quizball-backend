-- The retention-email worker aggregates users x match_players x matches. Its
-- join reads only `started_at` and filters `is_dev`, but had to visit the
-- 408 MB `matches` heap for each row: prod EXPLAIN showed an Index Scan on
-- matches_pkey with loops=148,629 and 594,521 shared buffer hits (~4.6 GB of
-- pages) per run, at 827.9 ms mean.
--
-- INCLUDE (started_at) makes it an Index Only Scan, so the heap is not touched.
-- Red/green on a local reproduction at prod scale (18,388 users / 124,315
-- matches / 248,630 match_players, prod plan shape forced): 124.2 ms -> 72.2 ms
-- (-42%), 558,887 -> 499,953 buffers.
--
-- This is the secondary fix; the primary one is not running the scan on every
-- 60s tick (see retention-journey.service.ts).
--
-- NOT built CONCURRENTLY — see 20260904140000 and 20260820073707: the runner's
-- advisory lock makes the whole migration run one transaction, which
-- CONCURRENTLY cannot join. The partial predicate keeps the build short, and
-- lock_timeout bounds the SHARE lock on matches.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS matches_id_started_at_not_dev_idx
  ON public.matches (id) INCLUDE (started_at)
  WHERE is_dev = false;
