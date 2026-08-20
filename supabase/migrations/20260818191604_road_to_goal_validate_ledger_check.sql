ALTER TABLE public.store_transaction_logs
  VALIDATE CONSTRAINT store_transaction_logs_event_type_check;

-- A later recovery migration removes any interrupted global-ledger index and
-- installs the dedicated Road to Goal idempotency-key table. Keeping this step
-- transactional lets the event-type constraint finish independently.
