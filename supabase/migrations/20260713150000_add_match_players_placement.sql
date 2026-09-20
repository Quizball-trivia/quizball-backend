-- Hotfix record: applied manually to prod on 2026-07-13 during the
-- recent-matches outage. The promoted stats query selects
-- match_players.placement, which is otherwise created by the auction
-- migration 20260623210000 (staging-only). IF NOT EXISTS keeps this
-- idempotent with that migration when auction ships.
ALTER TABLE public.match_players
  ADD COLUMN IF NOT EXISTS placement smallint NULL;
