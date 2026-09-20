-- migrate:no-transaction
ALTER TABLE public.store_transaction_logs VALIDATE CONSTRAINT store_transaction_logs_event_type_check;
