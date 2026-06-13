-- Notifications retention: keep the in-app feed to a rolling 3-day window.
--
-- Why: the notifications table is insert-only (one row per alert, never
-- deleted) so it would grow unbounded. A 3-day window keeps the bell feed
-- recent and the table small; anything older is no longer shown and is pruned.
--
-- Strategy:
--   * A daily pg_cron job deletes notifications older than 3 days.
--   * Repos can additionally filter by created_at to stay consistent between
--     runs, but the feed query's LIMIT already keeps it bounded in practice.
--
-- pg_cron lives in the cron schema (Supabase enables it on all projects).

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Unschedule any prior run of this job (idempotent re-deploys).
DO $$
DECLARE
  existing_job_id bigint;
BEGIN
  SELECT jobid INTO existing_job_id
  FROM cron.job
  WHERE jobname = 'cleanup-old-notifications';

  IF existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job_id);
  END IF;
END $$;

-- Daily at 03:30 UTC: drop notifications older than 3 days.
SELECT cron.schedule(
  'cleanup-old-notifications',
  '30 3 * * *',
  $$
    DELETE FROM public.notifications
    WHERE created_at < NOW() - INTERVAL '3 days'
  $$
);
