-- Global ticket refill — replaces the per-user lazy refill (tickets_refill_started_at).
--
-- Old behaviour: 1 ticket per 4h, anchored to when a user dropped below MAX. The
-- anchor reset on every consume-from-full, so an active player kept restarting
-- their own refill clock and effectively never accrued during play (only during
-- long idle gaps). Multiple players reported "I'm not getting my refill".
--
-- New behaviour: a single global cron grants +1 ticket to every real user who has
-- room (< 5) at a predictable cadence — the SAME wall-clock times for everyone.
-- Target grid: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 Georgia time
-- (Asia/Tbilisi, fixed UTC+4, no DST). pg_cron runs in UTC, and UTC
-- 0,4,8,12,16,20 maps to Georgia 04,08,12,16,20,00 — exactly that grid.
--
-- Full users skip the tick (the `tickets < 5` guard prevents overflow). AI and
-- deleted/pending-deletion accounts are excluded. The app-side lazy refill is
-- removed in the same PR, so this cron is the SOLE refill source (no double
-- grant). `tickets_refill_started_at` is left in place but inert; a later
-- migration can drop it once nothing reads it.

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.refill_tickets_global()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  refilled_count integer := 0;
BEGIN
  UPDATE public.users
  SET tickets = tickets + 1,
      updated_at = NOW()
  WHERE tickets < 5
    AND is_ai = false
    AND is_deleted = false
    AND deleted_at IS NULL
    AND pending_deletion_at IS NULL;

  GET DIAGNOSTICS refilled_count = ROW_COUNT;
  RETURN refilled_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refill_tickets_global() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refill_tickets_global() FROM anon;
REVOKE EXECUTE ON FUNCTION public.refill_tickets_global() FROM authenticated;

-- Idempotent (re)schedule.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refill-tickets-every-4h') THEN
    PERFORM cron.unschedule('refill-tickets-every-4h');
  END IF;
END;
$$;

-- UTC 00,04,08,12,16,20  ==  Georgia 04,08,12,16,20,00.
SELECT cron.schedule(
  'refill-tickets-every-4h',
  '0 0,4,8,12,16,20 * * *',
  'SELECT public.refill_tickets_global()'
);
