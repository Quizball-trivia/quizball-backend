-- Placement seed cap: best possible placement result is now top of Reserve
-- (875 RP) instead of World-Class entry (2600 RP). Every tier from Bench up
-- must be climbed through regular ranked play.
--
-- Code-side (ranked.service.ts): the raw placement perf scale is unchanged,
-- but the final seed is linearly mapped from the legacy 0–2600 range onto
-- 0–875. This migration aligns the DB with the new starting point:
--
--  1) New profiles start at 600 RP / 'Reserve' (was 1200 / 'Rotation') so an
--     unplaced player never displays a higher tier than placements can award.
--  2) Existing profiles that have NOT completed placements and still sit on
--     the old untouched default (rp = 1200) are moved to the new default.
--     Players already placed keep their RP/tier — the cap only applies to
--     future placement runs.

ALTER TABLE public.ranked_profiles
  ALTER COLUMN rp SET DEFAULT 600;

UPDATE public.ranked_profiles
SET rp = 600,
    tier = 'Reserve',
    updated_at = now()
WHERE placement_status <> 'placed'
  AND rp = 1200;
