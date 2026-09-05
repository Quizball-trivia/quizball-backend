-- Remembers which players PostHog said do not match a retention experiment
-- flag, so the worker does not ask again every 60s tick. Remote flag
-- evaluation is billed per request: 148,806 requests on 2026-09-03 for ~300
-- assignments, because a "does not match" answer was never recorded and the
-- candidate scans returned the same players every minute.
-- Browser roles receive no grants; only the backend service role touches it.

CREATE TABLE public.retention_flag_exclusions (
  feature_flag_key text NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  excluded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (feature_flag_key, user_id)
);

COMMENT ON TABLE public.retention_flag_exclusions IS
  'Players PostHog reported as not matching a retention experiment flag (reason no_condition_match / out_of_rollout_bound). '
  'The candidate scans skip a player for up to 3 days after excluded_at, clamped to the campaign''s own inactivity floor. '
  'Only definite answers are recorded: request failures, quota limits, evaluation errors, a missing or paused flag are never written here. '
  'After raising a rollout or changing a flag condition, re-evaluate everyone at once with: '
  'DELETE FROM retention_flag_exclusions WHERE feature_flag_key = ''<flag>''.';

ALTER TABLE public.retention_flag_exclusions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.retention_flag_exclusions FROM anon, authenticated;

-- Rows stop mattering after the TTL; purge them so the primary key stays small.
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
DECLARE
  existing_job_id bigint;
BEGIN
  SELECT jobid INTO existing_job_id
  FROM cron.job
  WHERE jobname = 'purge-retention-flag-exclusions';
  IF existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job_id);
  END IF;
END $$;

SELECT cron.schedule(
  'purge-retention-flag-exclusions',
  '40 3 * * *',
  $$
    DELETE FROM public.retention_flag_exclusions
    WHERE excluded_at < NOW() - INTERVAL '7 days'
  $$
);
