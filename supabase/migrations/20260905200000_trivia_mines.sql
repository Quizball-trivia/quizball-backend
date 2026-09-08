-- Trivia Mines: house-banked solo mini game with real coins.
-- 25 tiles, 4 defenders derived from a committed server seed; scouting questions from the published pool.
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
      'trivia_mines_refund'
    )
  ) NOT VALID;

CREATE TABLE IF NOT EXISTS public.trivia_mines_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cashed', 'lost', 'expired')),
  phase text NOT NULL DEFAULT 'picking'
    CHECK (phase IN ('picking', 'question', 'settled')),
  state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  stake_coins integer NOT NULL CHECK (stake_coins BETWEEN 1 AND 100000),
  -- FAIR pot in milli-coins (×1000): per-pick flooring in whole coins distorted the RTP at small stakes.
  pot_milli bigint NOT NULL CHECK (pot_milli BETWEEN 0 AND 1000000000),
  opened integer[] NOT NULL DEFAULT '{}',
  flagged integer[] NOT NULL DEFAULT '{}',
  bust_tile integer,
  scouts_left integer NOT NULL DEFAULT 3 CHECK (scouts_left BETWEEN 0 AND 3),
  question_id uuid,
  question_payload jsonb,
  question_correct_option text,
  question_deadline_at timestamptz,
  server_seed text NOT NULL,
  commit_hash text NOT NULL,
  client_nonce text,
  payout_coins integer CHECK (payout_coins IS NULL OR payout_coins >= 0),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT chk_trivia_mines_terminal CHECK (
    (status = 'active' AND settled_at IS NULL AND phase <> 'settled')
    OR (status <> 'active' AND settled_at IS NOT NULL AND phase = 'settled')
  ),
  CONSTRAINT chk_trivia_mines_question_snapshot CHECK (
    (question_id IS NULL AND question_payload IS NULL
      AND question_correct_option IS NULL AND question_deadline_at IS NULL)
    OR (question_id IS NOT NULL AND question_payload IS NOT NULL
      AND question_correct_option IS NOT NULL AND question_deadline_at IS NOT NULL)
  ),
  CONSTRAINT chk_trivia_mines_question_phase CHECK (
    (phase = 'question') = (question_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trivia_mines_active_round
  ON public.trivia_mines_rounds (user_id) WHERE status = 'active';
-- A start retried with the same client nonce replays the round instead of debiting a second stake.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trivia_mines_user_nonce
  ON public.trivia_mines_rounds (user_id, client_nonce) WHERE client_nonce IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trivia_mines_rounds_user
  ON public.trivia_mines_rounds (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trivia_mines_rounds_stale
  ON public.trivia_mines_rounds (last_seen_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_trivia_mines_rounds_cashed
  ON public.trivia_mines_rounds (settled_at DESC) WHERE status = 'cashed';

CREATE OR REPLACE FUNCTION public.trivia_mines_rounds_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_trivia_mines_rounds_updated_at ON public.trivia_mines_rounds;
CREATE TRIGGER trg_trivia_mines_rounds_updated_at
  BEFORE UPDATE ON public.trivia_mines_rounds
  FOR EACH ROW EXECUTE FUNCTION public.trivia_mines_rounds_touch_updated_at();

CREATE TABLE IF NOT EXISTS public.trivia_mines_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES public.trivia_mines_rounds(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  state_version integer NOT NULL,
  event_type text NOT NULL CHECK (
    event_type IN ('start', 'pick', 'bust', 'question_dealt', 'answer', 'question_expired', 'cashout', 'auto_cashout', 'expired', 'refunded')
  ),
  tile integer,
  question_id uuid,
  answer_option text,
  answer_correct boolean,
  answer_ms integer,
  flagged_tile integer,
  commit_hash text,
  server_seed text,
  client_nonce text,
  hmac_input text,
  pot_before_milli bigint,
  pot_after_milli bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trivia_mines_events_round ON public.trivia_mines_events (round_id, id);
CREATE INDEX IF NOT EXISTS idx_trivia_mines_events_user_question ON public.trivia_mines_events (user_id, id DESC) WHERE question_id IS NOT NULL;

-- Retried stake/payout writes lose a unique-index race instead of moving coins twice.
-- No CONCURRENTLY: the migration runner holds a transaction (owner rule 2026-09-04).
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_tx_trivia_mines_idempotency
  ON public.store_transaction_logs (event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND outcome = 'success'
    AND event_type IN ('trivia_mines_stake', 'trivia_mines_payout', 'trivia_mines_refund');

ALTER TABLE public.trivia_mines_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trivia_mines_events ENABLE ROW LEVEL SECURITY;
