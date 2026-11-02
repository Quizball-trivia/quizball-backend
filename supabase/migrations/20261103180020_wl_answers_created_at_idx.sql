-- migrate:no-transaction
-- Time-window reads (HQ activity rollup refresh, admin-stats actives) filter on
-- created_at; staging seq-scanned 255k rows for a one-day window.
CREATE INDEX CONCURRENTLY IF NOT EXISTS wl_answers_created_at_idx
  ON public.wl_answers (created_at);
