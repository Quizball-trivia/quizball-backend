-- Free Kicks: house-banked solo game mode (real coins, provably-fair keeper).
--
-- 1. Extends the store transaction-log event types with the two Free Kicks
--    money events and adds a REAL idempotency unique index for them — the
--    existing uq_store_tx_manual_adjustment_idempotency covers only manual
--    adjustments, so money-event retries were otherwise not deduplicated.
-- 2. free_kicks_rounds: one row per round, the single source of truth for the
--    round state machine. Every mutation runs under SELECT ... FOR UPDATE with
--    an optimistic state_version. The pending question is snapshotted (payload,
--    shuffled options, locale) so scoring can never diverge from what was
--    shown; question_correct_option never leaves the backend.
-- 3. free_kicks_events: immutable per-action audit (fairness proofs per shot,
--    answers with timings, settlements). Also serves as the served-question
--    history used to avoid repeats.
-- 4. updated_at trigger (matches learned this the hard way — see
--    20260602100000_matches_updated_at_trigger.sql) and RLS deny-all on both
--    tables: backend service-role access only, mirroring nickname_history.

-- ── 1. Ledger event types + money idempotency ────────────────────────────────

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
      'free_kicks_payout'
    )
  );

-- Retried settlements must lose the insert race instead of double-crediting.
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_tx_free_kicks_idempotency
  ON public.store_transaction_logs (event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND outcome = 'success'
    AND event_type IN ('free_kicks_stake', 'free_kicks_payout');

-- ── 2. Rounds ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.free_kicks_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT: money-adjacent audit records must survive account deletion
  -- decisions explicitly, never via cascade.
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cashed', 'lost', 'expired')),
  -- Explicit persisted phase — financial eligibility is never derived from
  -- loosely related nullable columns.
  phase text NOT NULL DEFAULT 'deciding'
    CHECK (phase IN ('deciding', 'question', 'post_goal', 'settled')),
  state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  stake_coins integer NOT NULL CHECK (stake_coins BETWEEN 1 AND 100000),
  pot_coins integer NOT NULL CHECK (pot_coins BETWEEN 0 AND 1000000),
  attack integer NOT NULL DEFAULT 0 CHECK (attack BETWEEN 0 AND 10000),
  open_count integer NOT NULL DEFAULT 2 CHECK (open_count BETWEEN 2 AND 6),
  answer_locked boolean NOT NULL DEFAULT false,
  goals integer NOT NULL DEFAULT 0 CHECK (goals >= 0),
  -- Pending question snapshot (all four set together, or none).
  question_id uuid,
  question_payload jsonb,
  question_correct_option text,
  question_deadline_at timestamptz,
  -- Provably-fair state for the CURRENT attack; every resolved shot is also
  -- archived immutably in free_kicks_events.
  server_seed text NOT NULL,
  commit_hash text NOT NULL,
  client_nonce text,
  payout_coins integer CHECK (payout_coins IS NULL OR payout_coins >= 0),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT chk_free_kicks_terminal CHECK (
    (status = 'active' AND settled_at IS NULL AND phase <> 'settled')
    OR (status <> 'active' AND settled_at IS NOT NULL AND phase = 'settled')
  ),
  CONSTRAINT chk_free_kicks_payout_state CHECK (
    (status = 'cashed' AND payout_coins IS NOT NULL)
    OR (status <> 'cashed' AND payout_coins IS NULL)
  ),
  CONSTRAINT chk_free_kicks_question_snapshot CHECK (
    (question_id IS NULL AND question_payload IS NULL
      AND question_correct_option IS NULL AND question_deadline_at IS NULL)
    OR (question_id IS NOT NULL AND question_payload IS NOT NULL
      AND question_correct_option IS NOT NULL AND question_deadline_at IS NOT NULL)
  ),
  CONSTRAINT chk_free_kicks_question_phase CHECK (
    (phase = 'question') = (question_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_free_kicks_active_round
  ON public.free_kicks_rounds (user_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_free_kicks_rounds_user
  ON public.free_kicks_rounds (user_id, created_at DESC);

-- Sweeper scans only stale ACTIVE rounds.
CREATE INDEX IF NOT EXISTS idx_free_kicks_rounds_stale
  ON public.free_kicks_rounds (last_seen_at)
  WHERE status = 'active';

-- updated_at is load-bearing for staleness decisions — enforce it in the DB.
CREATE OR REPLACE FUNCTION public.free_kicks_rounds_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_free_kicks_rounds_updated_at ON public.free_kicks_rounds;
CREATE TRIGGER trg_free_kicks_rounds_updated_at
  BEFORE UPDATE ON public.free_kicks_rounds
  FOR EACH ROW
  EXECUTE FUNCTION public.free_kicks_rounds_touch_updated_at();

-- ── 3. Immutable per-action audit / fairness proofs ─────────────────────────

CREATE TABLE IF NOT EXISTS public.free_kicks_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES public.free_kicks_rounds(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  attack integer NOT NULL,
  state_version integer NOT NULL,
  event_type text NOT NULL CHECK (
    event_type IN (
      'start', 'question_dealt', 'answer', 'question_expired',
      'shot', 'next_attack', 'cashout', 'auto_cashout', 'expired'
    )
  ),
  question_id uuid,
  answer_option text,
  answer_correct boolean,
  answer_ms integer,
  open_count integer,
  picked_zone text,
  keeper_zone text,
  scored boolean,
  commit_hash text,
  server_seed text,
  client_nonce text,
  hmac_input text,
  pot_before integer,
  pot_after integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_free_kicks_events_round
  ON public.free_kicks_events (round_id, id);

-- Served-question history: powers "don't repeat questions for this user".
CREATE INDEX IF NOT EXISTS idx_free_kicks_events_user_question
  ON public.free_kicks_events (user_id, question_id)
  WHERE question_id IS NOT NULL;

-- ── 4. Access control: backend-only (service role), deny-all for clients ────

ALTER TABLE public.free_kicks_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.free_kicks_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.free_kicks_rounds FROM anon, authenticated;
REVOKE ALL ON public.free_kicks_events FROM anon, authenticated;
