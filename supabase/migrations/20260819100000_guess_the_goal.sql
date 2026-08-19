-- Guess the Goal: solo knowledge mini-game (iconic goals replayed as animated
-- tactics diagrams; the player names the goal from 4 options).
--
-- 1. goal_choreographies: the content library. Bilingual JSONB text fields,
--    draft/published/archived lifecycle (agents publish here, CMS reviews
--    drafts), scorer/match/year identity columns for dedupe.
-- 2. guess_the_goal_sessions: one row per play. Server-authoritative scoring:
--    the correct option never leaves the backend before the guess, and the
--    points decay is computed from started_at on the SERVER clock, never from
--    a client-reported reveal count.
-- 3. guess_the_goal_solves: first-ever correct solve per (user, goal) — the
--    reward gate. Coins/XP are granted only when this insert wins.
-- 4. Ledger: rewards flow through store_transaction_logs
--    ('guess_the_goal_reward') with a real idempotency index — same money
--    pattern free_kicks established. Unlike free_kicks we build the partial
--    index in-transaction (no concurrent build): it matches zero existing
--    rows, so the scan is one pass and we avoid the invalid-index-left-behind
--    failure mode of concurrent builds under IF NOT EXISTS.
-- 5. XP source enum gains 'guess_the_goal_solve' (user_xp_events is already
--    idempotent on (user_id, source_type, source_key)).
-- 6. RLS deny-all on all three tables: backend service-role access only.

-- ── 1. Ledger event type + XP source ────────────────────────────────────────

ALTER TABLE public.store_transaction_logs
  DROP CONSTRAINT IF EXISTS store_transaction_logs_event_type_check;

ALTER TABLE public.store_transaction_logs
  ADD CONSTRAINT store_transaction_logs_event_type_check
  CHECK (
    event_type IN (
      'checkout_session_created',
      'checkout_session_failed',
      'webhook_received',
      'webhook_signature_invalid',
      'fulfillment_succeeded',
      'fulfillment_failed',
      'manual_adjustment_succeeded',
      'manual_adjustment_failed',
      'objective_reward_succeeded',
      'admin_progression_adjustment',
      'leaderboard_reset',
      'admin_ticket_window_reset',
      'admin_account_ban',
      'admin_account_unban',
      'free_kicks_stake',
      'free_kicks_payout',
      'guess_the_goal_reward'
    )
  ) NOT VALID;
-- NOT VALID for the same reason as 20260818110000_free_kicks.sql: the ledger is
-- append-only and large; existing rows satisfied the previous stricter list.
-- Validated in 20260819100002.

ALTER TABLE public.user_xp_events
  DROP CONSTRAINT IF EXISTS user_xp_events_source_type_check;

ALTER TABLE public.user_xp_events
  ADD CONSTRAINT user_xp_events_source_type_check
  CHECK (
    source_type IN (
      'daily_challenge_completion',
      'match_result',
      'objective_reward',
      'guess_the_goal_solve'
    )
  ) NOT VALID;
-- NOT VALID for the same reason: no full-table scan while this batch holds
-- earlier exclusive locks. Validated in 20260819100001.

-- Retried settlements must lose the insert race instead of double-crediting.
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_tx_guess_the_goal_idempotency
  ON public.store_transaction_logs (event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND outcome = 'success'
    AND event_type = 'guess_the_goal_reward';

-- ── 2. Content library ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.goal_choreographies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'archived')),
  difficulty text NOT NULL DEFAULT 'medium'
    CHECK (difficulty IN ('easy', 'medium', 'hard')),
  -- Full answer line, {en, ka}: "Carlos Alberto — Brazil vs Italy, 1970 final"
  title jsonb NOT NULL,
  -- Exactly 4 of {id, text: {en, ka}, is_correct} — enforced in the service
  -- schema; the DB guards only the shape basics.
  options jsonb NOT NULL,
  fun_fact jsonb,
  -- {question: {en, ka}, options: [4 x {id, text: {en, ka}, is_correct}]}
  bonus jsonb,
  -- Diagram data (68x105 pitch): [{id, team, at: [x, y]}]
  players jsonb NOT NULL,
  -- [{kind: pass|carry|run|shot, player, to, via?, loft?, withPrev?, duration}]
  steps jsonb NOT NULL,
  -- Identity metadata for dedupe and search (never localized). goal_ordinal
  -- disambiguates two goals by the same scorer in the same match.
  scorer text NOT NULL,
  match_label text NOT NULL,
  year integer NOT NULL CHECK (year BETWEEN 1900 AND 2100),
  goal_ordinal smallint NOT NULL DEFAULT 1 CHECK (goal_ordinal BETWEEN 1 AND 9),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  source text NOT NULL DEFAULT 'editor'
    CHECK (source IN ('seed', 'agent', 'editor')),
  created_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ggt_options_array CHECK (jsonb_typeof(options) = 'array'),
  CONSTRAINT chk_ggt_players_array CHECK (jsonb_typeof(players) = 'array'),
  CONSTRAINT chk_ggt_steps_array CHECK (jsonb_typeof(steps) = 'array')
);

-- One choreography per real-world goal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_goal_choreographies_identity
  ON public.goal_choreographies (lower(scorer), lower(match_label), year, goal_ordinal);

CREATE INDEX IF NOT EXISTS idx_goal_choreographies_published
  ON public.goal_choreographies (status)
  WHERE status = 'published';

-- ── 3. Sessions ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.guess_the_goal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT: reward-adjacent audit records must survive account deletion
  -- decisions explicitly, never via cascade (free_kicks precedent).
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  goal_id uuid NOT NULL REFERENCES public.goal_choreographies(id) ON DELETE RESTRICT,
  -- Immutable snapshot of exactly what was served (anonymized players/steps,
  -- options with correctness, bonus, title, fun fact). Guesses are judged
  -- against this, never against the live content row, so CMS/agent edits can
  -- never change the rules of a session in flight.
  goal_snapshot jsonb NOT NULL,
  state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'guessed', 'complete', 'abandoned')),
  -- Points ceiling fixed at creation: 100 normally, clamped to the floor (40)
  -- when the user has seen this goal in a previous session (anti-scouting).
  max_points integer NOT NULL CHECK (max_points BETWEEN 0 AND 1000),
  started_at timestamptz NOT NULL DEFAULT now(),
  guessed_at timestamptz,
  guess_option_id text,
  guess_correct boolean,
  revealed_moves integer CHECK (revealed_moves IS NULL OR revealed_moves >= 0),
  points integer NOT NULL DEFAULT 0 CHECK (points >= 0),
  bonus_option_id text,
  bonus_correct boolean,
  bonus_points integer NOT NULL DEFAULT 0 CHECK (bonus_points >= 0),
  first_solve boolean NOT NULL DEFAULT false,
  -- Main-guess awards and bonus awards are recorded SEPARATELY so a retried
  -- mutation can replay its exact original response.
  coins_awarded integer NOT NULL DEFAULT 0 CHECK (coins_awarded >= 0),
  xp_awarded integer NOT NULL DEFAULT 0 CHECK (xp_awarded >= 0),
  bonus_coins_awarded integer NOT NULL DEFAULT 0 CHECK (bonus_coins_awarded >= 0),
  bonus_xp_awarded integer NOT NULL DEFAULT 0 CHECK (bonus_xp_awarded >= 0),
  client_nonce text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ggt_guess_recorded CHECK (
    (state = 'active' AND guessed_at IS NULL AND guess_option_id IS NULL)
    OR (state = 'abandoned')
    OR (state IN ('guessed', 'complete') AND guessed_at IS NOT NULL AND guess_option_id IS NOT NULL)
  ),
  -- 'guessed' = correct guess awaiting the bonus answer; a wrong guess goes
  -- straight to 'complete'.
  CONSTRAINT chk_ggt_guessed_is_correct CHECK (state <> 'guessed' OR guess_correct = true)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ggt_sessions_active
  ON public.guess_the_goal_sessions (user_id)
  WHERE state IN ('active', 'guessed');

-- Idempotent session start: a retried POST with the same nonce returns the
-- already-created session instead of minting a second one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ggt_sessions_nonce
  ON public.guess_the_goal_sessions (user_id, client_nonce)
  WHERE client_nonce IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ggt_sessions_user
  ON public.guess_the_goal_sessions (user_id, created_at DESC);

-- "Has this user seen this goal before?" (max_points clamp) — and the daily
-- coin-cap sum scans the same (user, day) slice.
CREATE INDEX IF NOT EXISTS idx_ggt_sessions_user_goal
  ON public.guess_the_goal_sessions (user_id, goal_id);

DROP TRIGGER IF EXISTS trg_ggt_sessions_updated_at ON public.guess_the_goal_sessions;
CREATE TRIGGER trg_ggt_sessions_updated_at
  BEFORE UPDATE ON public.guess_the_goal_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.free_kicks_rounds_touch_updated_at();

DROP TRIGGER IF EXISTS trg_goal_choreographies_updated_at ON public.goal_choreographies;
CREATE TRIGGER trg_goal_choreographies_updated_at
  BEFORE UPDATE ON public.goal_choreographies
  FOR EACH ROW
  EXECUTE FUNCTION public.free_kicks_rounds_touch_updated_at();

-- ── 4. First-solve gate ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.guess_the_goal_solves (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  goal_id uuid NOT NULL REFERENCES public.goal_choreographies(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL REFERENCES public.guess_the_goal_sessions(id) ON DELETE RESTRICT,
  solved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, goal_id)
);

-- ── 5. RLS: service-role only ────────────────────────────────────────────────

ALTER TABLE public.goal_choreographies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guess_the_goal_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guess_the_goal_solves ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.goal_choreographies FROM anon, authenticated;
REVOKE ALL ON public.guess_the_goal_sessions FROM anon, authenticated;
REVOKE ALL ON public.guess_the_goal_solves FROM anon, authenticated;
