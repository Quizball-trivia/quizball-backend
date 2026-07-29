-- PR10 CMS live-tuning controls.
--
-- Three concerns:
--   1. bot_tuning_overrides — a SINGLETON row of live-editable governor/model
--      knobs, read at match time through a short Redis cache so a CMS change
--      propagates without a redeploy.
--   2. synthetic_player_profiles.selection_frozen — per-bot kill switch that
--      removes one bot from live selection without retiring it.
--   3. One-time normalization of daily_cap values above the new hard rail (12).
--
-- Expand-only and idempotent: safe to run while the previous release serves.

-- 1. LIVE TUNING OVERRIDES ---------------------------------------------------
--
-- Singleton (id = true) rather than a versioned table: these are operator knobs
-- with one current value, not a calibration artifact with an audit lineage.
-- bot_model_params stays the versioned home for the fitted model; this table
-- only carries the handful of scalars an operator may move live.
--
-- Every column is NULLABLE and means "no override — use the code constant".
-- That keeps the code constants the source of truth for anything the operator
-- has not deliberately touched, so a new constant added in a later PR does not
-- silently inherit a stale DB value.
CREATE TABLE IF NOT EXISTS public.bot_tuning_overrides (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  -- Monotonic config version, bumped by trigger on every update. Stamped into
  -- each match's ranked_context pin alongside the params version, so any bot
  -- decision can be traced back to the exact operator config in force at the
  -- time — the post-incident reproducibility that live tuning would otherwise
  -- destroy.
  version integer NOT NULL DEFAULT 1,
  -- Ceiling margin in PROBABILITY points below the frozen top-cohort accuracy.
  -- Larger margin = weaker bots. The API rejects any value that would raise the
  -- effective cap above the frozen HARD_PROB_CAP, so this can only TIGHTEN.
  ceiling_margin numeric(6,4) CHECK (ceiling_margin IS NULL OR (ceiling_margin >= 0 AND ceiling_margin <= 0.5)),
  -- Governor win-rate targets. Hard-railed at 0.55 by both API and CHECK: a
  -- target above that steers bots toward beating humans more often than not.
  top_band_target_winrate numeric(5,4) CHECK (top_band_target_winrate IS NULL OR (top_band_target_winrate > 0 AND top_band_target_winrate <= 0.55)),
  mid_ladder_target_winrate numeric(5,4) CHECK (mid_ladder_target_winrate IS NULL OR (mid_ladder_target_winrate > 0 AND mid_ladder_target_winrate <= 0.55)),
  -- Governor step sizes in theta units, bounded so one step cannot re-skill a bot.
  governor_step numeric(5,4) CHECK (governor_step IS NULL OR (governor_step > 0 AND governor_step <= 0.25)),
  top_protection_step numeric(5,4) CHECK (top_protection_step IS NULL OR (top_protection_step > 0 AND top_protection_step <= 0.5)),
  -- Top-protection ring radii in RP. Wider = protection engages earlier.
  top_protection_margin_rp integer CHECK (top_protection_margin_rp IS NULL OR (top_protection_margin_rp >= 0 AND top_protection_margin_rp <= 2000)),
  top_protection_critical_rp integer CHECK (top_protection_critical_rp IS NULL OR (top_protection_critical_rp >= 0 AND top_protection_critical_rp <= 2000)),
  -- Roster-wide activity scaling: multiplies each bot's daily_cap at selection
  -- time. 0 = roster effectively idle, 1 = as generated.
  activity_scale numeric(4,3) CHECK (activity_scale IS NULL OR (activity_scale >= 0 AND activity_scale <= 2)),
  -- Roster-wide ceiling on any single bot's effective daily cap.
  max_daily_cap smallint CHECK (max_daily_cap IS NULL OR (max_daily_cap >= 1 AND max_daily_cap <= 12)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

COMMENT ON TABLE public.bot_tuning_overrides IS
  'Singleton of live-editable persistent-bot tuning knobs (PR10). NULL column = use the code constant. Safety rails are enforced in the API AND by these CHECKs; neither can loosen the immutable hard clamps in hard-clamps.ts.';

-- Version bump trigger. Done in the DB rather than the app so EVERY writer
-- (app, psql, a future CMS-side job) advances the version — a version that can
-- be bypassed is worthless as a provenance stamp.
CREATE OR REPLACE FUNCTION public.bump_bot_tuning_version()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_bump_bot_tuning_version ON public.bot_tuning_overrides;
CREATE TRIGGER trg_bump_bot_tuning_version
  BEFORE UPDATE ON public.bot_tuning_overrides
  FOR EACH ROW
  EXECUTE FUNCTION public.bump_bot_tuning_version();

-- Seed the singleton so the API can always UPDATE rather than branch on upsert.
INSERT INTO public.bot_tuning_overrides (id) VALUES (true)
  ON CONFLICT (id) DO NOTHING;

-- 2. PER-BOT SELECTION FREEZE ------------------------------------------------
--
-- Distinct from status='retired': a frozen bot keeps its profile, RP and
-- governor state and can be unfrozen instantly. Retirement is permanent and
-- also removes the bot from the governor's offset summary.
ALTER TABLE public.synthetic_player_profiles
  ADD COLUMN IF NOT EXISTS selection_frozen boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.synthetic_player_profiles.selection_frozen IS
  'Operator freeze (PR10): excluded from live selection while keeping profile/RP/governor state intact. Reversible, unlike status=retired.';

-- Selection filters on (status, selection_frozen); a partial index over the
-- live set keeps the eligibility scan on the small active-and-unfrozen subset.
CREATE INDEX IF NOT EXISTS idx_synthetic_profiles_selectable
  ON public.synthetic_player_profiles (user_id)
  WHERE status = 'active' AND NOT selection_frozen;

-- 3. ONE-TIME DAILY-CAP NORMALIZATION ---------------------------------------
--
-- daily_cap is a smallint COLUMN on synthetic_player_profiles (the generator
-- writes it directly in scripts/persistent-bot-roster/create.ts; the schedule
-- jsonb carries only the activity archetype). Roster generation sampled caps
-- from archetype quantiles that can exceed the new hard rail of 12.
--
-- Clamp every out-of-rail row into 8-12 with a DETERMINISTIC jitter derived
-- from personality_seed, so the roster keeps a spread of caps instead of a
-- visible cliff of identical values, and so re-running this migration is a
-- no-op (same seed -> same value, and the WHERE clause no longer matches).
UPDATE public.synthetic_player_profiles
  SET daily_cap = 8 + (abs(personality_seed) % 5)::smallint,
      updated_at = now()
  WHERE daily_cap > 12;
