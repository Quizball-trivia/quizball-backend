-- Runaway-query reaper. Prod runs behind Supavisor in TRANSACTION mode, which
-- strips startup-param and role-GUC statement_timeouts; only SET LOCAL inside
-- transactions survives (see src/db/index.ts). Plain single-statement reads
-- therefore run UNBOUNDED: an abandoned getActiveMatchForUser SELECT executed
-- for 10h38m on 2026-07-14, degrading all reads until killed by hand.
-- Every 5 minutes, terminate app SELECTs active for >5 minutes. SELECT-only so
-- migrations, DDL, and batch UPDATE jobs are never touched; autovacuum and
-- replication workers have no query text matching 'select%'.
CREATE OR REPLACE FUNCTION public.reap_runaway_selects()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  reaped integer;
BEGIN
  SELECT count(*) INTO reaped
  FROM (
    SELECT pg_terminate_backend(pid)
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND state = 'active'
      AND pid <> pg_backend_pid()
      AND now() - query_start > interval '5 minutes'
      AND query ILIKE 'select%'
  ) t;
  RETURN reaped;
END;
$$;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'reap-runaway-selects';

SELECT cron.schedule(
  'reap-runaway-selects',
  '*/5 * * * *',
  $$SELECT public.reap_runaway_selects()$$
);
