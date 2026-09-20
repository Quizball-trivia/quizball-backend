-- Guest identity for the public game pages: an opaque server-issued token lets a
-- signed-out visitor play today's real daily sets without an account. Guests never
-- touch wallets, XP, streaks or leaderboards; their completions live in their own
-- table so the users FKs on the real tables stay intact.
CREATE TABLE IF NOT EXISTS public.guest_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  locale text,
  ip_hash text,
  device_hash text,
  -- Set once the visitor registers and the client links its guest history (phase 3b).
  linked_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_guest_sessions_last_seen ON public.guest_sessions (last_seen_at);

CREATE TABLE IF NOT EXISTS public.guest_daily_completions (
  guest_id uuid NOT NULL REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
  challenge_type text NOT NULL,
  challenge_day date NOT NULL,
  best_score integer NOT NULL CHECK (best_score >= 0),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guest_id, challenge_type, challenge_day)
);

ALTER TABLE public.guest_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guest_daily_completions ENABLE ROW LEVEL SECURITY;
