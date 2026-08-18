-- Validate the event-type CHECK added NOT VALID in 20260818110000_free_kicks.sql
-- (SHARE UPDATE EXCLUSIVE only — ledger writes keep flowing). Separate file from
-- the CONCURRENTLY index: one statement per non-transactional file.
ALTER TABLE public.store_transaction_logs
  VALIDATE CONSTRAINT store_transaction_logs_event_type_check;
