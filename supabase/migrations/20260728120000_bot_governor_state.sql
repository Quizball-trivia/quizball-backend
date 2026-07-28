-- PR9 governor: the one piece of per-bot state PR1's columns did not cover.
--
-- PR1 (20260727150100) added governor_adjustment / winrate_ema /
-- winrate_samples / governor_updated_at. The cooldown, however, is specified in
-- §1.5 as "a per-bot cooldown between adjustments" measured in BOTH wall-clock
-- time and settled matches. The match half needs an anchor: how many samples the
-- bot had when its offset last moved. Without it a burst of matches inside one
-- cooldown window could ratchet the offset repeatedly.
--
-- Expand-only and idempotent: a nullable column with a 0 default. Old app
-- versions ignore it, so this is safe to run while the previous release serves.
ALTER TABLE public.synthetic_player_profiles
  ADD COLUMN IF NOT EXISTS governor_samples_at_adjustment integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.synthetic_player_profiles.governor_samples_at_adjustment IS
  'winrate_samples value at the moment governor_adjustment last changed; the match-count half of the governor cooldown (PR9, plan 1.5).';

-- Daily bot-vs-human win/loss telemetry (plan 1.10). A VIEW, not a table: the
-- ranked ledger already holds every settled result, so an aggregate cannot drift
-- from the source of truth and there is nothing to backfill or reconcile.
--
-- One row per Georgia day per bot-result. ranked_rp_changes rows exist for
-- persistent bots (PR2 settles them like humans); opponent_is_ai = false keeps
-- this to matches actually played against HUMANS, which is the only win rate the
-- governor and the 40-45% target are defined against.
CREATE OR REPLACE VIEW public.persistent_bot_daily_winrate AS
SELECT
  ((rc.created_at AT TIME ZONE 'Asia/Tbilisi'))::date AS georgia_day,
  COUNT(*) FILTER (WHERE rc.result = 'win')::int      AS bot_wins,
  COUNT(*) FILTER (WHERE rc.result = 'loss')::int     AS bot_losses,
  COUNT(*)::int                                       AS total_matches,
  COUNT(DISTINCT rc.user_id)::int                     AS distinct_bots
FROM public.ranked_rp_changes rc
JOIN public.users u ON u.id = rc.user_id
WHERE u.ai_kind = 'persistent'
  AND rc.opponent_is_ai = false
GROUP BY 1;

COMMENT ON VIEW public.persistent_bot_daily_winrate IS
  'Per-Georgia-day persistent-bot win/loss totals vs HUMAN opponents, derived live from ranked_rp_changes (PR9 telemetry).';

-- Views inherit the querying role''s privileges, and RLS on the underlying
-- tables still applies. Revoke the anon/authenticated grants that CREATE VIEW
-- would otherwise leave in place: this is internal telemetry, read via the
-- service role by the ops endpoint only (matches the 20260702000000 lockdown).
REVOKE ALL ON public.persistent_bot_daily_winrate FROM anon, authenticated;
