-- migrate:no-transaction
-- Time-window reads (HQ activity rollup refresh, admin-stats actives) filter on
-- created_at; without this the planner walked the whole (user_id, created_at)
-- index from disk (~7 s for a 30-day window on 1.44M rows on staging).
CREATE INDEX CONCURRENTLY IF NOT EXISTS free_kicks_rounds_created_at_idx
  ON public.free_kicks_rounds (created_at);
