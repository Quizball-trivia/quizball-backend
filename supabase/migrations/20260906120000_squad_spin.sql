-- Squad Spin: house-banked solo mini game with real coins.
-- Reels (club · nation · position, + league/manager/trophy on harder runs) land on a
-- precomputed combo; the player names a footballer who fits every reel within 15s.
-- Content is a self-contained snapshot of the verified Grid release (players, aliases,
-- criteria, combos), so the game does not depend on the grid tables being present.
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
      'guess_the_goal_reward',
      'road_to_goal_stake',
      'road_to_goal_payout',
      'trivia_mines_stake',
      'trivia_mines_payout',
      'trivia_mines_refund',
      'squad_spin_stake',
      'squad_spin_payout',
      'squad_spin_refund'
    )
  ) NOT VALID;

-- Content snapshot -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.squad_spin_criteria (
  id uuid PRIMARY KEY,
  family text NOT NULL CHECK (family IN ('club', 'country', 'league', 'manager', 'trophy_award')),
  criterion_key text NOT NULL,
  label_en text NOT NULL,
  label_ka text NOT NULL,
  asset_key text,
  content_version integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS public.squad_spin_players (
  id uuid PRIMARY KEY,
  name_en text NOT NULL,
  name_ka text,
  image_url text,
  position_group text NOT NULL CHECK (position_group IN ('GK', 'DEF', 'MID', 'FWD')),
  nationality_code text,
  peak_value_eur bigint,
  content_version integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS public.squad_spin_player_aliases (
  player_id uuid NOT NULL REFERENCES public.squad_spin_players(id) ON DELETE CASCADE,
  normalized_alias text NOT NULL CHECK (length(normalized_alias) BETWEEN 1 AND 160),
  locale text NOT NULL CHECK (locale IN ('en', 'ka', 'translit')),
  acceptance_policy text NOT NULL CHECK (acceptance_policy IN ('exact', 'unique_only', 'safe_typo')),
  PRIMARY KEY (player_id, normalized_alias, locale)
);

CREATE TABLE IF NOT EXISTS public.squad_spin_combos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reels smallint NOT NULL CHECK (reels BETWEEN 3 AND 5),
  club_id uuid NOT NULL REFERENCES public.squad_spin_criteria(id) ON DELETE RESTRICT,
  nation_id uuid NOT NULL REFERENCES public.squad_spin_criteria(id) ON DELETE RESTRICT,
  position_group text NOT NULL CHECK (position_group IN ('GK', 'DEF', 'MID', 'FWD')),
  -- 0, 1 or 2 extra criteria (league / manager / trophy) for 4- and 5-reel runs.
  extra_ids uuid[] NOT NULL DEFAULT '{}',
  answer_ids uuid[] NOT NULL CHECK (cardinality(answer_ids) >= 1),
  n_answers smallint NOT NULL CHECK (n_answers >= 1),
  tier text NOT NULL CHECK (tier IN ('t3e', 't3m', 't4', 't5')),
  active boolean NOT NULL DEFAULT true,
  content_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, nation_id, position_group, extra_ids)
);
CREATE INDEX IF NOT EXISTS idx_squad_spin_combos_reels_active
  ON public.squad_spin_combos (reels, id) WHERE active;

-- A combo is not dealt twice to the same player inside the seen window, so a
-- revealed answer cannot be cashed in on a later run (pool would be harvestable).
CREATE TABLE IF NOT EXISTS public.squad_spin_seen_combos (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  combo_id uuid NOT NULL REFERENCES public.squad_spin_combos(id) ON DELETE CASCADE,
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, combo_id)
);
CREATE INDEX IF NOT EXISTS idx_squad_spin_seen_combos_user_seen
  ON public.squad_spin_seen_combos (user_id, seen_at DESC);

-- Pricing -------------------------------------------------------------------
-- One immutable snapshot per UTC day: measured human accuracy per tier and the
-- step multipliers derived from it. Rounds freeze the steps they started with.
CREATE TABLE IF NOT EXISTS public.squad_spin_calibrations (
  publication_day date PRIMARY KEY,
  accuracy_bp jsonb NOT NULL CHECK (jsonb_typeof(accuracy_bp) = 'object'),
  steps_bp jsonb NOT NULL CHECK (jsonb_typeof(steps_bp) = 'object'),
  samples jsonb NOT NULL CHECK (jsonb_typeof(samples) = 'object'),
  rules_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Rounds --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.squad_spin_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cashed', 'lost', 'expired')),
  phase text NOT NULL DEFAULT 'question'
    CHECK (phase IN ('question', 'decision', 'settled')),
  state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  stake_coins integer NOT NULL CHECK (stake_coins BETWEEN 1 AND 100000),
  reels smallint NOT NULL CHECK (reels BETWEEN 3 AND 5),
  -- FAIR pot (margin is applied at cash-out).
  pot_coins integer NOT NULL CHECK (pot_coins BETWEEN 0 AND 1000000),
  spins_cleared integer NOT NULL DEFAULT 0 CHECK (spins_cleared >= 0),
  combo_id uuid REFERENCES public.squad_spin_combos(id) ON DELETE RESTRICT,
  combo_ids uuid[] NOT NULL DEFAULT '{}',
  question_dealt_at timestamptz,
  question_deadline_at timestamptz,
  decision_deadline_at timestamptz,
  steps_bp jsonb NOT NULL CHECK (jsonb_typeof(steps_bp) = 'object'),
  calibration_day date NOT NULL,
  server_seed text NOT NULL,
  commit_hash text NOT NULL,
  client_nonce text,
  payout_coins integer CHECK (payout_coins IS NULL OR payout_coins >= 0),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT chk_squad_spin_terminal CHECK (
    (status = 'active' AND settled_at IS NULL AND phase <> 'settled')
    OR (status <> 'active' AND settled_at IS NOT NULL AND phase = 'settled')
  ),
  CONSTRAINT chk_squad_spin_question_phase CHECK (
    phase <> 'question' OR (combo_id IS NOT NULL AND question_deadline_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_squad_spin_active_round
  ON public.squad_spin_rounds (user_id) WHERE status = 'active';
-- A start retried with the same client nonce replays the round instead of debiting a second stake.
CREATE UNIQUE INDEX IF NOT EXISTS uq_squad_spin_user_nonce
  ON public.squad_spin_rounds (user_id, client_nonce) WHERE client_nonce IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_squad_spin_rounds_user
  ON public.squad_spin_rounds (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_squad_spin_rounds_stale
  ON public.squad_spin_rounds (last_seen_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_squad_spin_rounds_cashed
  ON public.squad_spin_rounds (settled_at DESC) WHERE status = 'cashed';

CREATE OR REPLACE FUNCTION public.squad_spin_rounds_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_squad_spin_rounds_updated_at ON public.squad_spin_rounds;
CREATE TRIGGER trg_squad_spin_rounds_updated_at
  BEFORE UPDATE ON public.squad_spin_rounds
  FOR EACH ROW EXECUTE FUNCTION public.squad_spin_rounds_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.squad_spin_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES public.squad_spin_rounds(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  state_version integer NOT NULL,
  event_type text NOT NULL CHECK (
    event_type IN ('start', 'spin_dealt', 'answer', 'continue', 'cashout', 'auto_cashout', 'expired', 'refunded')
  ),
  spin_index integer,
  combo_id uuid,
  tier text,
  submitted_text text,
  resolved_player_id uuid,
  -- answer rows only: true/false; a timeout is recorded as false with answer_late = true.
  answer_correct boolean,
  answer_late boolean,
  answer_ms integer,
  commit_hash text,
  server_seed text,
  client_nonce text,
  hmac_input text,
  pot_before integer,
  pot_after integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_squad_spin_events_round ON public.squad_spin_events (round_id, id);
-- Calibration reads recent answers per tier.
CREATE INDEX IF NOT EXISTS idx_squad_spin_events_answers
  ON public.squad_spin_events (created_at DESC) WHERE event_type = 'answer';

-- Retried stake/payout writes lose a unique-index race instead of moving coins twice.
-- No CONCURRENTLY: the migration runner holds a transaction (owner rule 2026-09-04).
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_tx_squad_spin_idempotency
  ON public.store_transaction_logs (event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND outcome = 'success'
    AND event_type IN ('squad_spin_stake', 'squad_spin_payout', 'squad_spin_refund');

ALTER TABLE public.squad_spin_criteria ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squad_spin_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squad_spin_player_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squad_spin_combos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squad_spin_seen_combos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squad_spin_calibrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squad_spin_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.squad_spin_events ENABLE ROW LEVEL SECURITY;
