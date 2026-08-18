-- Free Kicks follow-up: unique idempotency index on the ledger, built without
-- blocking writes. CONCURRENTLY cannot run inside a transaction block, and the
-- runner sends a file's whole body as one implicit-transaction batch — so this
-- file must contain EXACTLY ONE statement (same pattern as
-- 20260629100000_ai_cleanup_match_answers_index.sql).

-- Retried settlements must lose the insert race instead of double-crediting.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_store_tx_free_kicks_idempotency
  ON public.store_transaction_logs (event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND outcome = 'success'
    AND event_type IN ('free_kicks_stake', 'free_kicks_payout');
