-- Persist the coin participation reward credited with each ranked settlement.
--
-- The settlement transaction credits users.coins; storing the amount on the
-- rp-change row makes replays/getMatchOutcome report what was actually paid
-- (pre-rollout rows default to 0 — nothing was credited for them) instead of
-- recomputing from the current reward constants.
ALTER TABLE public.ranked_rp_changes
ADD COLUMN IF NOT EXISTS coins_awarded integer NOT NULL DEFAULT 0;
