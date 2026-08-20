-- Validate the merged mini-game ledger event CHECK separately so production
-- writes are not blocked by a table rewrite or an access-exclusive lock.

ALTER TABLE public.store_transaction_logs
  VALIDATE CONSTRAINT store_transaction_logs_event_type_check;
