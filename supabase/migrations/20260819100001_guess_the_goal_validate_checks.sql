-- Validate the two CHECK constraints added NOT VALID in 20260819100000
-- (SHARE UPDATE EXCLUSIVE only — ledger and XP writes keep flowing while the
-- existing rows are scanned).
ALTER TABLE public.store_transaction_logs
  VALIDATE CONSTRAINT store_transaction_logs_event_type_check;

ALTER TABLE public.user_xp_events
  VALIDATE CONSTRAINT user_xp_events_source_type_check;
