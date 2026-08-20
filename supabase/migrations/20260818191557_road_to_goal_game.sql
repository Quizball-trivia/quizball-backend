-- Road to Goal: server-authoritative 11-question, real-coin solo game.
-- Correct answers live only in the backend-owned round snapshot; RLS and
-- explicit grants keep both state and audit rows inaccessible to clients.

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
      'road_to_goal_payout'
    )
  ) NOT VALID;

CREATE TABLE IF NOT EXISTS public.road_to_goal_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'cashed', 'lost', 'completed')),
  phase text NOT NULL DEFAULT 'question'
    CHECK (phase IN ('question', 'decision', 'settled')),
  state_version integer NOT NULL DEFAULT 0 CHECK (state_version >= 0),
  stake_coins integer NOT NULL CHECK (stake_coins IN (10, 25, 50)),
  cleared_zones integer NOT NULL DEFAULT 0 CHECK (cleared_zones BETWEEN 0 AND 11),
  -- Eleven immutable snapshots including server-only correct_option_id fields.
  run_questions jsonb NOT NULL CHECK (
    jsonb_typeof(run_questions) = 'array'
    AND jsonb_array_length(run_questions) = 11
  ),
  question_deadline_at timestamptz,
  client_nonce uuid NOT NULL,
  payout_coins integer CHECK (payout_coins IS NULL OR payout_coins BETWEEN 0 AND 200),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT chk_road_to_goal_terminal CHECK (
    (status = 'active' AND phase <> 'settled' AND settled_at IS NULL)
    OR (status <> 'active' AND phase = 'settled' AND settled_at IS NOT NULL)
  ),
  CONSTRAINT chk_road_to_goal_payout CHECK (
    (status IN ('cashed', 'completed') AND payout_coins IS NOT NULL)
    OR (status NOT IN ('cashed', 'completed') AND payout_coins IS NULL)
  ),
  CONSTRAINT chk_road_to_goal_question_phase CHECK (
    (phase = 'question') = (question_deadline_at IS NOT NULL)
  ),
  CONSTRAINT chk_road_to_goal_completed CHECK (
    status <> 'completed' OR cleared_zones = 11
  ),
  CONSTRAINT chk_road_to_goal_progress_phase CHECK (
    (phase = 'question' AND cleared_zones BETWEEN 0 AND 10)
    OR (phase = 'decision' AND cleared_zones BETWEEN 1 AND 10)
    OR phase = 'settled'
  ),
  CONSTRAINT chk_road_to_goal_cashout_progress CHECK (
    status <> 'cashed' OR cleared_zones BETWEEN 1 AND 10
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_road_to_goal_active_round
  ON public.road_to_goal_rounds (user_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uq_road_to_goal_user_nonce
  ON public.road_to_goal_rounds (user_id, client_nonce);

CREATE INDEX IF NOT EXISTS idx_road_to_goal_rounds_user
  ON public.road_to_goal_rounds (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_road_to_goal_rounds_stale
  ON public.road_to_goal_rounds (last_seen_at)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_road_to_goal_rounds_question_deadline
  ON public.road_to_goal_rounds (question_deadline_at)
  WHERE status = 'active' AND phase = 'question';

CREATE OR REPLACE FUNCTION public.road_to_goal_rounds_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_road_to_goal_rounds_updated_at ON public.road_to_goal_rounds;
CREATE TRIGGER trg_road_to_goal_rounds_updated_at
  BEFORE UPDATE ON public.road_to_goal_rounds
  FOR EACH ROW
  EXECUTE FUNCTION public.road_to_goal_rounds_touch_updated_at();

-- Compact per-player rotation state. A row is updated only when a question is
-- actually served, so unseen snapshots in an abandoned run do not count as
-- player exposure.
CREATE TABLE IF NOT EXISTS public.road_to_goal_question_exposures (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  question_id uuid NOT NULL REFERENCES public.questions(id) ON DELETE RESTRICT,
  exposure_count integer NOT NULL DEFAULT 1 CHECK (exposure_count > 0),
  first_exposed_at timestamptz NOT NULL DEFAULT now(),
  last_exposed_at timestamptz NOT NULL DEFAULT now(),
  last_round_id uuid NOT NULL REFERENCES public.road_to_goal_rounds(id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, question_id)
);

-- Foreign-key support for question archival/deletion checks and round cleanup.
CREATE INDEX IF NOT EXISTS idx_road_to_goal_question_exposures_question
  ON public.road_to_goal_question_exposures (question_id);

CREATE INDEX IF NOT EXISTS idx_road_to_goal_question_exposures_round
  ON public.road_to_goal_question_exposures (last_round_id);

CREATE TABLE IF NOT EXISTS public.road_to_goal_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  round_id uuid NOT NULL REFERENCES public.road_to_goal_rounds(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL,
  zone integer NOT NULL CHECK (zone BETWEEN 1 AND 11),
  state_version integer NOT NULL CHECK (state_version >= 0),
  event_type text NOT NULL CHECK (
    event_type IN (
      'start', 'question_dealt', 'answer', 'continue',
      'cashout', 'auto_cashout', 'complete', 'timeout'
    )
  ),
  question_id uuid,
  answer_option text,
  correct_option text,
  answer_correct boolean,
  answer_ms integer CHECK (answer_ms IS NULL OR answer_ms >= 0),
  multiplier_bp integer,
  stake_coins integer,
  payout_coins integer,
  client_nonce uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_road_to_goal_events_round
  ON public.road_to_goal_events (round_id, id);

ALTER TABLE public.road_to_goal_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.road_to_goal_question_exposures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.road_to_goal_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.road_to_goal_rounds FROM anon, authenticated;
REVOKE ALL ON public.road_to_goal_question_exposures FROM anon, authenticated;
REVOKE ALL ON public.road_to_goal_events FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.road_to_goal_rounds_touch_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.road_to_goal_events_id_seq FROM PUBLIC, anon, authenticated;
