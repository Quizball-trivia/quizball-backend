-- Two indexes on `matches`, both for queries that were reading from disk on
-- prod. Measured 2026-09-04 from pg_stat_statements (shared_blks_read) and
-- reproduced locally at prod scale (124,368 matches / 106,798 lobbies).
--
-- 1. matches (lobby_id)
--
-- `matches.lobby_id` is a FOREIGN KEY with ON DELETE SET NULL but had no index,
-- so every `DELETE FROM lobbies` ran the constraint trigger as a Seq Scan over
-- the 413 MB matches table to find the rows to null out. On prod that DELETE
-- was 578,294 shared_blks_read at 291 ms mean — the single largest source of
-- disk reads in the database. Every other lobbies child (lobby_members,
-- lobby_categories, lobby_category_bans, lobby_challenge_invitations) already
-- has its FK indexed; this one was missed.
--
--   DELETE FROM lobbies    ~38 ms  ->   9.7 ms  (-74%)
--   FK trigger             28.4 ms ->   0.5 ms  (-98%)
--   buffers                24,884  ->      29   (-99.9%)
--
-- 2. matches (started_at DESC)
--
-- `SELECT count(*) FROM matches WHERE started_at > now() - ...` had no
-- supporting index and ran as a Parallel Seq Scan: 421,959 shared_blks_read at
-- 815 ms mean on prod. DESC matches the "recent first" access pattern; btree
-- scans either direction so plain ASC would also work.
--
--   count(*)               16.2 ms ->  0.67 ms  (-96%)
--   buffers                24,876  ->      19   (-99.9%)
--   plan                   Parallel Seq Scan -> Index Only Scan
--
-- Cost: 6.4 MB of index for both, and insert throughput was unchanged in a
-- 5,000-row measurement.
--
-- NOT built CONCURRENTLY: the migration runner holds pg_advisory_xact_lock
-- inside a transaction for the whole run, so CONCURRENTLY fails with "cannot
-- run inside a transaction block" — that broke the 2026-09-04 prod deploy (see
-- 20260904140000 and 20260820073707). lock_timeout bounds the wait instead of
-- letting a deploy hang behind a long-running writer.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS matches_lobby_id_idx
  ON public.matches (lobby_id);

CREATE INDEX IF NOT EXISTS matches_started_at_idx
  ON public.matches (started_at DESC);
