-- migrate:no-transaction
-- Time-window reads (HQ activity rollup refresh, admin-stats actives).
CREATE INDEX CONCURRENTLY IF NOT EXISTS squad_spin_rounds_created_at_idx
  ON public.squad_spin_rounds (created_at);
