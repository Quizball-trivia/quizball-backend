-- Two more indexes from the 2026-09-04 round-2 audit.
--
-- 1. agents.sessions (status) — partial
--
-- The UPDATE that closes an agent session filters on `status`, which had no
-- index, so it ran as a Seq Scan over 43,217 rows: 465 calls at 27.76 ms mean
-- in a 2h prod window, the largest single query cost left after the earlier
-- fixes. It is also why agents.sessions showed 1,858,479 sequential scans
-- reading 60.4 billion rows — the worst seq-scan figure in the database —
-- even after the started_at index landed.
--
-- Partial, because the distribution is extremely skewed: 37,298 of 43,217 rows
-- are 'succeeded' and only the in-flight states are ever searched for
-- (agents.repo.ts filters on 'running'). Indexing the terminal states would
-- triple the write cost for rows nothing looks up.
--
-- Red/green on a local reproduction (43,217 rows, same skew and row width):
--   UPDATE ... WHERE status='running'   12.1 ms -> 3.4 ms  (-72%)
--   buffers                              8,903  ->   433   (-95%)
--   index size                                      16 kB
--
-- 2. ranked_rp_changes_archive (match_id)
--
-- Same bug class as matches.lobby_id in #633: a FOREIGN KEY with ON DELETE
-- CASCADE and no index, so every DELETE FROM matches scanned the archive to
-- find rows to cascade. `matches` has seen 18,103 deletes, so this fires in
-- practice.
--
-- Red/green on a local reproduction (119,693 matches / 150,000 archive rows,
-- 72 MB — prod's archive is 34 MB, so this is conservative):
--   DELETE FROM matches   32.5 ms -> 4.2 ms   (-87%)
--   FK trigger            18.2 ms -> 0.94 ms  (-95%)
--   index size                        4.2 MB
--
-- The audit found 12 unindexed FKs with CASCADE/SET NULL, but only this one has
-- a parent that is actually deleted at volume; the others' parents show 0-2
-- deletes lifetime, so indexing them would add write cost for no read benefit.
--
-- Not CONCURRENTLY: the migration runner holds pg_advisory_xact_lock inside a
-- transaction for the whole run (see 20260904140000, 20260820073707).
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS sessions_status_active_idx
  ON agents.sessions (status)
  WHERE status NOT IN ('succeeded', 'failed', 'timeout');

CREATE INDEX IF NOT EXISTS ranked_rp_changes_archive_match_id_idx
  ON public.ranked_rp_changes_archive (match_id);
