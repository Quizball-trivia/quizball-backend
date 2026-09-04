-- migrate:no-transaction
-- agents.sessions is filtered by started_at (the CMS/agents dashboards read
-- "sessions since X"), but had indexes only on id, task_id and job_id. On prod
-- that meant a Seq Scan removing 42,877 of 43,217 rows to return 100 — and
-- PostgREST issues a second `pgrst_source_count` CTE per request, so the 67 MB
-- table was scanned twice. Measured 2026-09-04: these two statement shapes were
-- 22.7% of ALL prod database time (36.1 ms and 18.2 ms mean, ~25k calls/14h).
--
-- Red/green on a local reproduction (43,217 rows, same row width, PostgREST
-- count shape): 13.6 ms -> 1.3 ms (-91%), 8,644 -> 293 buffers (-97%).
--
-- DESC matches the "most recent first" access pattern; btree can scan either
-- direction, so plain ASC would also work — DESC just avoids a backward scan.
-- Built CONCURRENTLY: the agents pipeline writes this table continuously.
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
  WHERE c.relname = 'sessions_started_at_idx'
    AND n.nspname = 'agents'
    AND NOT i.indisvalid;
  IF invalid_index IS NOT NULL THEN
    RAISE NOTICE 'Dropping invalid index %', invalid_index;
    EXECUTE format('DROP INDEX %s', invalid_index);
  END IF;
END $$;

CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_started_at_idx
  ON agents.sessions (started_at DESC);
