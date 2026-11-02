-- migrate:no-transaction
-- Time-window reads (HQ activity rollup refresh, admin-stats actives).
CREATE INDEX CONCURRENTLY IF NOT EXISTS road_to_goal_rounds_created_at_idx
  ON public.road_to_goal_rounds (created_at);
