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
CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_started_at_idx
  ON agents.sessions (started_at DESC);
