-- The hourly expiry job collided with friendsRepo.acceptRequest(), which locks
-- the target friend_requests row FOR UPDATE. Bound the cron to 500 old requests
-- and skip rows already owned by an app transaction. Any skipped/backlog rows
-- remain invisible through the repo's age filter and are retried next hour.

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'expire-friend-requests') THEN
    PERFORM cron.unschedule('expire-friend-requests');
  END IF;
END;
$$;

SELECT cron.schedule(
  'expire-friend-requests',
  '0 * * * *',
  $$
    WITH expired AS MATERIALIZED (
      SELECT request.id
      FROM public.friend_requests AS request
      WHERE request.status = 'pending'
        AND request.created_at < NOW() - INTERVAL '14 days'
      ORDER BY request.id
      LIMIT 500
      FOR UPDATE OF request SKIP LOCKED
    )
    UPDATE public.friend_requests AS request
    SET status = 'cancelled',
        updated_at = NOW()
    FROM expired
    WHERE request.id = expired.id
      AND request.status = 'pending'
  $$
);
