-- migrate:no-transaction
-- Activity windows (HQ rollup refresh, admin-stats actives/games) filter duels
-- by started_at.
CREATE INDEX CONCURRENTLY IF NOT EXISTS duel_matches_started_at_idx
  ON public.duel_matches (started_at) WHERE started_at IS NOT NULL;
