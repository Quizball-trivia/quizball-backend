-- Server-owned state for the Daily comeback experiment.
--
-- The visual experiment must not be able to mint coins from the browser.
-- A unique award row makes the streak bonus idempotent even when two different
-- Daily modes finish concurrently. Reminder rows are likewise one-per-player
-- and are consumed by the backend reminder worker when delivery is enabled.

CREATE TABLE IF NOT EXISTS public.daily_challenge_streak_bonus_awards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  challenge_day date NOT NULL,
  coins_awarded integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_daily_challenge_streak_bonus_user_day UNIQUE (user_id, challenge_day),
  CONSTRAINT chk_daily_challenge_streak_bonus_coins CHECK (coins_awarded > 0)
);

CREATE INDEX IF NOT EXISTS idx_daily_challenge_streak_bonus_user_day
  ON public.daily_challenge_streak_bonus_awards (user_id, challenge_day DESC);

ALTER TABLE public.daily_challenge_streak_bonus_awards ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.daily_challenge_reminders (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  remind_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  sent_at timestamptz,
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_daily_challenge_reminder_status
    CHECK (status IN ('pending', 'sending', 'sent', 'cancelled', 'failed')),
  CONSTRAINT chk_daily_challenge_reminder_attempts CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS idx_daily_challenge_reminders_pending_due
  ON public.daily_challenge_reminders (remind_at, user_id)
  WHERE status = 'pending';

ALTER TABLE public.daily_challenge_reminders ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_daily_challenge_reminders_set_updated_at
  ON public.daily_challenge_reminders;
CREATE TRIGGER trg_daily_challenge_reminders_set_updated_at
  BEFORE UPDATE ON public.daily_challenge_reminders
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

COMMENT ON TABLE public.daily_challenge_streak_bonus_awards IS
  'Backend-owned idempotency ledger for one Daily streak bonus per player and calendar day.';
COMMENT ON TABLE public.daily_challenge_reminders IS
  'Backend-owned one-time Daily Challenge reminder queue; direct browser access is blocked by RLS.';
