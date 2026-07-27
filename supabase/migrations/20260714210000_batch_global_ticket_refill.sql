-- Bound the global ticket refill's lock footprint.
--
-- The original refill_tickets_global() updated every eligible user in one
-- statement. PostgreSQL retained every row lock until the pg_cron invocation
-- committed, so wallet SELECT ... FOR UPDATE / UPDATE statements queued behind
-- the job and exhausted the application pool.
--
-- pg_cron invokes the procedure below with a top-level CALL. Procedures (unlike
-- functions and DO blocks) may COMMIT, so each 500-row chunk is its own short
-- transaction. FOR UPDATE SKIP LOCKED also makes the maintenance job yield to a
-- wallet operation that already owns a row lock instead of joining its queue.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Keep the legacy function safe for manual callers and regression tests. The
-- cron no longer uses it; a function cannot commit between chunks, so this
-- compatibility entry point intentionally performs at most one bounded chunk.
CREATE OR REPLACE FUNCTION public.refill_tickets_global()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  refilled_count integer := 0;
BEGIN
  WITH refill_batch AS MATERIALIZED (
    SELECT u.id
    FROM public.users AS u
    WHERE u.tickets < 5
      AND u.tickets_refill_started_at IS NOT NULL
      AND u.tickets_refill_started_at <= clock_timestamp() - INTERVAL '4 hours'
      AND u.is_ai = false
      AND u.is_deleted = false
      AND u.deleted_at IS NULL
      AND u.pending_deletion_at IS NULL
    ORDER BY u.id
    LIMIT 500
    FOR UPDATE OF u SKIP LOCKED
  ), refilled AS (
    UPDATE public.users AS u
    SET tickets = u.tickets + 1,
        tickets_refill_started_at = CASE
          WHEN u.tickets + 1 >= 5 THEN NULL
          ELSE u.tickets_refill_started_at + INTERVAL '4 hours'
        END,
        updated_at = clock_timestamp()
    FROM refill_batch AS batch
    WHERE u.id = batch.id
      AND u.tickets < 5
      AND u.tickets_refill_started_at IS NOT NULL
      AND u.tickets_refill_started_at <= clock_timestamp() - INTERVAL '4 hours'
    RETURNING 1
  )
  SELECT count(*)::integer INTO refilled_count
  FROM refilled;

  RETURN refilled_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.refill_tickets_global() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refill_tickets_global() FROM anon;
REVOKE EXECUTE ON FUNCTION public.refill_tickets_global() FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.refill_tickets_global() FROM service_role;

CREATE OR REPLACE PROCEDURE public.refill_tickets_global_batched(
  batch_size integer DEFAULT 500
)
LANGUAGE plpgsql
AS $$
DECLARE
  last_processed_id uuid := NULL;
  batch_last_id uuid;
BEGIN
  IF batch_size < 1 OR batch_size > 5000 THEN
    RAISE EXCEPTION 'batch_size must be between 1 and 5000';
  END IF;

  -- The postgres role has carried a 30s statement_timeout in production. It
  -- applies to the outer CALL as a whole, not independently to each committed
  -- chunk, so disable it on this dedicated pg_cron session. Attaching a SET
  -- clause to CREATE PROCEDURE would prohibit the COMMIT statements below.
  SET statement_timeout = 0;

  LOOP
    -- SET LOCAL must be re-applied after each COMMIT. SKIP LOCKED avoids row
    -- waits; lock_timeout also bounds less common relation/metadata waits.
    SET LOCAL lock_timeout = '2s';

    batch_last_id := NULL;

    WITH refill_batch AS MATERIALIZED (
      SELECT u.id
      FROM public.users AS u
      WHERE (last_processed_id IS NULL OR u.id > last_processed_id)
        AND u.tickets < 5
        AND u.tickets_refill_started_at IS NOT NULL
        AND u.tickets_refill_started_at <= clock_timestamp() - INTERVAL '4 hours'
        AND u.is_ai = false
        AND u.is_deleted = false
        AND u.deleted_at IS NULL
        AND u.pending_deletion_at IS NULL
      ORDER BY u.id
      LIMIT batch_size
      FOR UPDATE OF u SKIP LOCKED
    ), refilled AS (
      UPDATE public.users AS u
      SET tickets = u.tickets + 1,
          -- Advance exactly one interval. The id cursor prevents an old anchor
          -- from receiving multiple tickets in the same global tick.
          tickets_refill_started_at = CASE
            WHEN u.tickets + 1 >= 5 THEN NULL
            ELSE u.tickets_refill_started_at + INTERVAL '4 hours'
          END,
          updated_at = clock_timestamp()
      FROM refill_batch AS batch
      WHERE u.id = batch.id
        AND u.tickets < 5
        AND u.tickets_refill_started_at IS NOT NULL
        AND u.tickets_refill_started_at <= clock_timestamp() - INTERVAL '4 hours'
      RETURNING u.id
    )
    SELECT id INTO batch_last_id
    FROM refilled
    ORDER BY id DESC
    LIMIT 1;

    EXIT WHEN batch_last_id IS NULL;

    last_processed_id := batch_last_id;
    COMMIT;
  END LOOP;
END;
$$;

-- The procedure is intentionally SECURITY INVOKER: PostgreSQL prohibits
-- transaction control in SECURITY DEFINER procedures. pg_cron runs this CALL
-- as the migration/owner role, while application roles remain unable to call it.
REVOKE EXECUTE ON PROCEDURE public.refill_tickets_global_batched(integer) FROM PUBLIC;
REVOKE EXECUTE ON PROCEDURE public.refill_tickets_global_batched(integer) FROM anon;
REVOKE EXECUTE ON PROCEDURE public.refill_tickets_global_batched(integer) FROM authenticated;
REVOKE EXECUTE ON PROCEDURE public.refill_tickets_global_batched(integer) FROM service_role;

-- Support the ordered eligible-row scan without repeatedly walking every user.
CREATE INDEX IF NOT EXISTS idx_users_ticket_refill_candidates
  ON public.users (id)
  WHERE tickets < 5
    AND tickets_refill_started_at IS NOT NULL
    AND is_ai = false
    AND is_deleted = false
    AND deleted_at IS NULL
    AND pending_deletion_at IS NULL;

-- Idempotently replace the mass-update job with the transaction-chunking CALL.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refill-tickets-every-4h') THEN
    PERFORM cron.unschedule('refill-tickets-every-4h');
  END IF;
END;
$$;

-- UTC 00,04,08,12,16,20 == Georgia 04,08,12,16,20,00.
SELECT cron.schedule(
  'refill-tickets-every-4h',
  '0 0,4,8,12,16,20 * * *',
  'CALL public.refill_tickets_global_batched(500)'
);
