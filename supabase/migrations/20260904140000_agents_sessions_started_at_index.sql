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
-- NOT built CONCURRENTLY, deliberately. The migration runner holds
-- pg_advisory_xact_lock inside a transaction for the whole run, so a
-- CONCURRENTLY build fails with "cannot run inside a transaction block" — this
-- migration did exactly that on the 2026-09-04 prod deploy, and
-- 20260820073707 documents the same constraint. At 43k rows the plain build
-- takes well under a second and the write lock is correspondingly brief.
-- lock_timeout bounds the wait rather than letting the deploy hang behind a
-- long-running writer.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS sessions_started_at_idx
  ON agents.sessions (started_at DESC);
