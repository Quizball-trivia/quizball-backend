-- Free Kicks follow-up: heavy ledger operations that must not block writes.
-- CONCURRENTLY cannot run inside a transaction block (same pattern as
-- 20260629100000_ai_cleanup_match_answers_index.sql).

-- Retried settlements must lose the insert race instead of double-crediting.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_store_tx_free_kicks_idempotency
  ON public.store_transaction_logs (event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND outcome = 'success'
    AND event_type IN ('free_kicks_stake', 'free_kicks_payout');

-- Validate the event-type CHECK added NOT VALID in the previous migration
-- (SHARE UPDATE EXCLUSIVE only — ledger writes keep flowing).
ALTER TABLE public.store_transaction_logs
  VALIDATE CONSTRAINT store_transaction_logs_event_type_check;
