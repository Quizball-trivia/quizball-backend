-- Per-bot admin editing (PATCH roster/:botUserId): audit trail + the bounds the
-- API relies on.
--
-- Three concerns:
--   1. bot_admin_edits — the audit lineage the tuning singleton deliberately
--      does NOT have. bot_tuning_overrides holds "one current value" by design
--      (see 20260729100000), so per-bot mutations of nickname/RP/skill/cap need
--      their own before->after log.
--   2. base_skill bounds — the 0.05..0.90 roster band range was a GENERATOR
--      convention only (scripts/persistent-bot-roster/measure.ts), never
--      enforced. The PATCH validator would otherwise be the single guard.
--   3. daily_cap bounds — 20260729100000 added this CHECK as NOT VALID; validate
--      it so the constraint covers pre-existing rows too.
--
-- Both bounds are applied only AFTER clamping any out-of-range legacy rows —
-- see the normalization block for why NOT VALID is not a safe shortcut here.
--
-- Idempotent: safe under manual apply + deploy runner re-run.

CREATE TABLE IF NOT EXISTS public.bot_admin_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- Which knob changed. One row PER FIELD per request, so a multi-field edit
  -- produces several rows sharing a request_id: before->after stays scalar and
  -- greppable instead of a jsonb blob nobody can query.
  field text NOT NULL
    CHECK (field IN ('nickname', 'rp', 'base_skill', 'daily_cap')),
  old_value text,
  new_value text NOT NULL,
  -- Groups the rows written by a single PATCH.
  request_id uuid NOT NULL,
  -- MANDATORY operator justification (API requires non-empty).
  note text NOT NULL CHECK (length(btrim(note)) > 0),
  -- Auth is a SHARED ops token, not a per-person login: this identifies the
  -- CALLER the token was used from, never an individual. Do not present it in
  -- the CMS as "who did this" — it cannot support that claim.
  actor text NOT NULL DEFAULT 'ops-token',
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bot_admin_edits IS
  'Before->after audit of per-bot admin edits from the CMS (nickname/RP/base_skill/daily_cap). One row per changed field; request_id groups a single PATCH. actor reflects the shared ops token, NOT an identified person.';

CREATE INDEX IF NOT EXISTS idx_bot_admin_edits_bot_created
  ON public.bot_admin_edits (bot_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_admin_edits_request
  ON public.bot_admin_edits (request_id);

ALTER TABLE public.bot_admin_edits ENABLE ROW LEVEL SECURITY;

-- NORMALIZE BEFORE CONSTRAINING.
--
-- NOT VALID is NOT a safe way to carry legacy bad rows forward here. It skips
-- the backfill scan, but the CHECK still fires on every UPDATE of an existing
-- row — so a single out-of-band base_skill would start rejecting the routine
-- governor offset and match-counter writes that touch that bot, silently
-- breaking it in live play. The same trap applies to daily_cap: 20260729100000
-- normalized only `> 12`, so any NEGATIVE legacy value would abort the VALIDATE
-- below and fail the deploy.
--
-- So: clamp both columns into range FIRST, then add/validate the constraints as
-- VALID. The roster is ~1k rows, so the validation scan is trivial. Both
-- statements are no-ops on a clean table, keeping the migration idempotent.
UPDATE public.synthetic_player_profiles
  SET base_skill = GREATEST(0.05, LEAST(0.90, base_skill)),
      updated_at = now()
  WHERE base_skill < 0.05 OR base_skill > 0.90;

UPDATE public.synthetic_player_profiles
  SET daily_cap = GREATEST(0, LEAST(12, daily_cap))::smallint,
      updated_at = now()
  WHERE daily_cap < 0 OR daily_cap > 12;

-- base_skill: the roster generator samples 0.05..0.90 across five bands; the
-- band range was a generator convention only until now. Added VALID: the rows
-- are clean as of the statement above, so the constraint covers existing rows
-- as well as future writes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.synthetic_player_profiles'::regclass
      AND conname = 'synthetic_profiles_base_skill_band'
  ) THEN
    ALTER TABLE public.synthetic_player_profiles
      ADD CONSTRAINT synthetic_profiles_base_skill_band
      CHECK (base_skill >= 0.05 AND base_skill <= 0.90);
  END IF;
END $$;

COMMENT ON COLUMN public.synthetic_player_profiles.base_skill IS
  'Hidden ability on the calibration scale, 0.05..0.90 (generator band range, now CHECK-enforced). Effective in-match skill = f(currentRp) + this + governor_adjustment, then clamped by hard-clamps.ts. Editing RP therefore ALSO moves difficulty.';

-- daily_cap: promote 20260729100000's NOT VALID CHECK to validated. That
-- migration left it NOT VALID on purpose, noting "a follow-up migration can
-- VALIDATE it once the deploy is confirmed". This is that follow-up — and it is
-- safe only because the clamp above covers the case that migration missed: it
-- normalized `> 12` but not negatives, which would abort this VALIDATE.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.synthetic_player_profiles'::regclass
      AND conname = 'synthetic_profiles_daily_cap_rail'
      AND NOT convalidated
  ) THEN
    ALTER TABLE public.synthetic_player_profiles
      VALIDATE CONSTRAINT synthetic_profiles_daily_cap_rail;
  END IF;
END $$;
