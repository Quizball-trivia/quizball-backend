-- Guests (users.is_guest) are account-less friend-room players with zero
-- balances by design. The global 4h ticket refill must not top them up —
-- neither live guests nor tombstoned ones (tombstoning keeps the row). Same
-- function body as 20260620000000 plus the is_guest exclusion; the pg_cron job
-- calls it by name, so no reschedule is needed.
SET LOCAL lock_timeout = '5s';

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
    AND is_guest = false
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

-- Repair any guest the cron already topped up.
UPDATE public.users SET tickets = 0, updated_at = NOW() WHERE is_guest = true AND tickets <> 0;
