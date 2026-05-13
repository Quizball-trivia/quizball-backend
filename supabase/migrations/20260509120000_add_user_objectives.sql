-- Daily / weekly objectives.

ALTER TABLE public.user_xp_events
  DROP CONSTRAINT IF EXISTS user_xp_events_source_type_check;

ALTER TABLE public.user_xp_events
  ADD CONSTRAINT user_xp_events_source_type_check
  CHECK (source_type IN ('daily_challenge_completion', 'match_result', 'objective_reward'));

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
      'objective_reward_succeeded'
    )
  );

CREATE TABLE IF NOT EXISTS public.user_objective_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  objective_id text NOT NULL,
  period_type text NOT NULL CHECK (period_type IN ('daily', 'weekly')),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  progress integer NOT NULL DEFAULT 0 CHECK (progress >= 0),
  target integer NOT NULL CHECK (target > 0),
  completed_at timestamptz,
  rewarded_at timestamptz,
  reward_coins integer NOT NULL DEFAULT 0 CHECK (reward_coins >= 0),
  reward_xp integer NOT NULL DEFAULT 0 CHECK (reward_xp >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_objective_period_valid CHECK (period_end > period_start),
  CONSTRAINT user_objective_reward_requires_completion CHECK (rewarded_at IS NULL OR completed_at IS NOT NULL),
  CONSTRAINT user_objective_period_unique UNIQUE (user_id, objective_id, period_start)
);

CREATE INDEX IF NOT EXISTS user_objective_progress_user_period_idx
  ON public.user_objective_progress (user_id, period_type, period_start DESC);

CREATE INDEX IF NOT EXISTS user_objective_progress_completion_idx
  ON public.user_objective_progress (user_id, completed_at)
  WHERE completed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.user_objective_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  objective_id text NOT NULL,
  period_start timestamptz NOT NULL,
  event_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_objective_event_unique UNIQUE (user_id, objective_id, period_start, event_key)
);

CREATE INDEX IF NOT EXISTS user_objective_events_user_period_idx
  ON public.user_objective_events (user_id, period_start DESC);

CREATE TABLE IF NOT EXISTS public.match_goal_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  seat smallint NOT NULL CHECK (seat IN (1, 2)),
  half smallint NOT NULL CHECK (half IN (1, 2)),
  phase_kind text NOT NULL CHECK (phase_kind IN ('normal', 'last_attack', 'shot', 'penalty')),
  q_index integer,
  is_penalty boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS match_goal_events_unique_goal
  ON public.match_goal_events (match_id, user_id, phase_kind, q_index, is_penalty);

CREATE INDEX IF NOT EXISTS match_goal_events_user_half_idx
  ON public.match_goal_events (user_id, half, created_at DESC);
