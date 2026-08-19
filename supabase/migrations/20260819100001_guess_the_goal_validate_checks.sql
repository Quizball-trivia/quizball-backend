-- Follow-up to 20260819100000, kept OUT of the table-DDL transaction so the
-- ledger index build and the constraint validations never stack their locks
-- on top of the feature's CREATE TABLE batch.
--
-- The index build is transactional-but-brief: the partial predicate matches
-- zero existing rows and the scan is a single pass. We accept that short
-- write pause over a concurrent build's invalid-index-left-behind failure
-- mode (this table is modest; free_kicks measured the same trade the other
-- way on 20260818110001).

-- Retried settlements must lose the insert race instead of double-crediting.
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_tx_guess_the_goal_idempotency
  ON public.store_transaction_logs (event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND outcome = 'success'
    AND event_type = 'guess_the_goal_reward';

-- Validate the two CHECK constraints added NOT VALID in 20260819100000
-- (SHARE UPDATE EXCLUSIVE only — ledger and XP writes keep flowing while the
-- existing rows are scanned).
ALTER TABLE public.store_transaction_logs
  VALIDATE CONSTRAINT store_transaction_logs_event_type_check;

ALTER TABLE public.user_xp_events
  VALIDATE CONSTRAINT user_xp_events_source_type_check;
