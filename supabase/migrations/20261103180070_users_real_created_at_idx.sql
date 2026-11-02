-- migrate:no-transaction
-- Signups per day / cohorts of real registered users (HQ analytics, retention).
CREATE INDEX CONCURRENTLY IF NOT EXISTS users_real_created_at_idx
  ON public.users (created_at)
  WHERE NOT is_ai AND NOT is_seed AND NOT is_guest AND NOT is_deleted;
