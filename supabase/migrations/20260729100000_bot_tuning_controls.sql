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
  -- DIRECTIONAL, mirroring tuning.schemas.ts. A generic bound is not enough: an
  -- absolute "<= 0.55" target would still let an operator make bots win MORE
  -- than the frozen 0.425/0.50 calibration. Each knob is constrained in its
  -- SAFE direction relative to the frozen constant, so a writer bypassing the
  -- API (psql, a future job) cannot loosen what the API advertises as a rail.
  ceiling_margin numeric(6,4) CHECK (ceiling_margin IS NULL OR (ceiling_margin >= 0.04 AND ceiling_margin <= 0.4031)),
  -- Targets may only be LOWERED below the frozen values (lower => weaker bots).
  top_band_target_winrate numeric(5,4) CHECK (top_band_target_winrate IS NULL OR (top_band_target_winrate > 0 AND top_band_target_winrate <= 0.425)),
  mid_ladder_target_winrate numeric(5,4) CHECK (mid_ladder_target_winrate IS NULL OR (mid_ladder_target_winrate > 0 AND mid_ladder_target_winrate <= 0.5)),
  -- Symmetric step drives BOTH nerfs and boosts, so it may only be REDUCED.
  governor_step numeric(5,4) CHECK (governor_step IS NULL OR (governor_step > 0 AND governor_step <= 0.1)),
  -- Protection step may only GROW: bigger => bot falls off the top faster.
  top_protection_step numeric(5,4) CHECK (top_protection_step IS NULL OR (top_protection_step >= 0.25 AND top_protection_step <= 0.5)),
  -- Rings may only WIDEN: wider => protection engages earlier.
  top_protection_margin_rp integer CHECK (top_protection_margin_rp IS NULL OR (top_protection_margin_rp >= 150 AND top_protection_margin_rp <= 2000)),
  top_protection_critical_rp integer CHECK (top_protection_critical_rp IS NULL OR (top_protection_critical_rp >= 50 AND top_protection_critical_rp <= 2000)),
  -- The critical ring must stay INSIDE the warn ring. A cross-column CHECK so a
  -- partial update cannot invert the rings against a stored value.
  CONSTRAINT bot_tuning_rings_nested CHECK (
    top_protection_critical_rp IS NULL
    OR top_protection_margin_rp IS NULL
    OR top_protection_critical_rp <= top_protection_margin_rp
  ),
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
-- `mod(x, 5)` rather than `abs(x) % 5`: abs() overflows on the minimum bigint
-- (there is no positive counterpart to -9223372036854775808), which would abort
-- the whole migration on one pathological seed. mod() is overflow-safe; the
-- extra +5 then %5 folds a negative remainder back into [0,4].
UPDATE public.synthetic_player_profiles
  SET daily_cap = (8 + ((mod(personality_seed, 5) + 5) % 5))::smallint,
      updated_at = now()
  WHERE daily_cap > 12;

-- DURABILITY. Without a constraint the normalization above is a one-shot clean
-- that any later generator run or manual write can undo, and re-running the
-- migration would be the only repair. The runtime operator cap in
-- synthetic-bot-selection.service.ts is defence in depth, not a substitute:
-- the invariant belongs in the schema.
--
-- NOT VALIDATED deliberately (expand/contract): adding a validating constraint
-- takes a lock that scans the table while the PREVIOUS app version is still
-- serving. The rows are already normalized above, so this only guards future
-- writes; a follow-up migration can VALIDATE it once the deploy is confirmed.
ALTER TABLE public.synthetic_player_profiles
  DROP CONSTRAINT IF EXISTS synthetic_profiles_daily_cap_rail;
ALTER TABLE public.synthetic_player_profiles
  ADD CONSTRAINT synthetic_profiles_daily_cap_rail
  CHECK (daily_cap >= 0 AND daily_cap <= 12) NOT VALID;
