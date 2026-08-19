-- Guess the Goal follow-up: unique idempotency index for its reward events,
-- built without blocking ledger writes. One statement per non-transactional
-- file (same pattern as 20260818110001_free_kicks_ledger_index.sql).

-- Retried settlements must lose the insert race instead of double-crediting.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_store_tx_guess_the_goal_idempotency
  ON public.store_transaction_logs (event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND outcome = 'success'
    AND event_type = 'guess_the_goal_reward';
