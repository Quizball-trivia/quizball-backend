ALTER TABLE public.store_transaction_logs
  VALIDATE CONSTRAINT store_transaction_logs_event_type_check;

-- The final online repair migrations recreate and validate the ledger index.
-- Keeping this step transactional lets the event-type constraint finish even
-- when a previous canceled concurrent build left an invalid index relation.
