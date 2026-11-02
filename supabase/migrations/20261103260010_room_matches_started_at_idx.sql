-- migrate:no-transaction
-- Activity windows (HQ rollup refresh, admin-stats actives/games) filter room
-- matches by started_at.
CREATE INDEX CONCURRENTLY IF NOT EXISTS room_matches_started_at_idx
  ON public.room_matches (started_at) WHERE started_at IS NOT NULL;
