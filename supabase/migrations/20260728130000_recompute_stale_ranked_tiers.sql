-- ranked_profiles.tier is a denormalized cache of tierFromRp(rp). The Season 1
-- rollover (20260721000100) re-tiered only live human profiles, so deleted,
-- pending-deletion and AI rows kept Season 1-curve tiers under the Season 2
-- thresholds (e.g. a 7585 RP row still stored as 'GOAT' where the current curve
-- says 'Legend'), and normalization is otherwise lazy (ensureProfile fires only
-- when the user touches ranked). The public leaderboard filters those rows and
-- was never affected, but stale badges can leak through single-user reads such
-- as the opponent tier shown in match history.
-- Recomputes only drifted rows; idempotent.
-- The CASE below MUST stay in lockstep with tierFromRp() in
-- src/modules/ranked/season-rp-formula.ts.
UPDATE public.ranked_profiles p
SET tier = c.computed_tier, updated_at = NOW()
FROM (
  SELECT user_id,
    CASE
      WHEN rp >= 9000 THEN 'GOAT'
      WHEN rp >= 6800 THEN 'Legend'
      WHEN rp >= 5200 THEN 'World-Class'
      WHEN rp >= 4000 THEN 'Captain'
      WHEN rp >= 3000 THEN 'Key Player'
      WHEN rp >= 2200 THEN 'Starting11'
      WHEN rp >= 1500 THEN 'Rotation'
      WHEN rp >= 1000 THEN 'Bench'
      WHEN rp >= 600 THEN 'Reserve'
      WHEN rp >= 300 THEN 'Youth Prospect'
      ELSE 'Academy'
    END AS computed_tier
  FROM public.ranked_profiles
) c
WHERE p.user_id = c.user_id
  AND p.tier <> c.computed_tier;
