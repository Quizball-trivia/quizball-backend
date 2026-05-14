-- Friend requests are auto-cancelled after 14 days of inactivity.
--
-- Why: stale pending requests clutter inboxes and prevent the sender from
-- re-adding the recipient (the bidirectional unique partial index blocks new
-- pending rows while an old one exists).
--
-- Strategy:
--   * Repo queries filter by created_at > NOW() - INTERVAL '14 days' so users
--     never see expired requests, even before this job runs.
--   * This pg_cron job flips status='pending' → 'cancelled' hourly so the
--     unique index frees up and re-adding works.
--
-- pg_cron lives in the cron schema (Supabase enables it on all projects).

-- Use 'cancelled' (existing CHECK constraint allows it) instead of adding a
-- new 'expired' status to keep the schema simple.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Unschedule any prior run of this job (idempotent re-deploys).
DO $$
DECLARE
  existing_job_id bigint;
BEGIN
  SELECT jobid INTO existing_job_id
  FROM cron.job
  WHERE jobname = 'expire-friend-requests';

  IF existing_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(existing_job_id);
  END IF;
END $$;

SELECT cron.schedule(
  'expire-friend-requests',
  '0 * * * *', -- top of every hour
  $$
    UPDATE public.friend_requests
    SET status = 'cancelled',
        updated_at = NOW()
    WHERE status = 'pending'
      AND created_at < NOW() - INTERVAL '14 days'
  $$
);
