-- migrate:no-transaction
-- Keep the scans out of the transactions that add columns and constraints.
-- Revalidating an already validated staging constraint is a no-op.
ALTER TABLE public.users VALIDATE CONSTRAINT chk_users_ai_kind_consistency;
ALTER TABLE public.users VALIDATE CONSTRAINT users_coin_fraction_minor_range;
