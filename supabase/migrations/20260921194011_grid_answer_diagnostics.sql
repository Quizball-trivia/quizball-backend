-- Expand before the backend deploy. Nullable, no backfill, no public policy/grant.
-- Keep on rollback: old backends ignore this column; historical attempts stay NULL.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
ALTER TABLE public.football_grid_attempts
  ADD COLUMN IF NOT EXISTS resolution_diagnostics jsonb;
COMMENT ON COLUMN public.football_grid_attempts.resolution_diagnostics IS
  'Private resolver v1 reason and bounded candidate IDs. Describes stored knowledge, not proof an answer is factually invalid. NULL means not captured (old backend/pass).';
