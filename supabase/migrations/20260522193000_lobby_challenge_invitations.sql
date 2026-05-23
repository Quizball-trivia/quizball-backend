CREATE TABLE IF NOT EXISTS public.lobby_challenge_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lobby_id uuid NOT NULL REFERENCES public.lobbies(id) ON DELETE CASCADE,
  from_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  to_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT lobby_challenge_invitations_distinct_users CHECK (from_user_id <> to_user_id),
  CONSTRAINT lobby_challenge_invitations_status_check CHECK (
    status IN ('pending', 'accepted', 'declined', 'canceled', 'expired')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS lobby_challenge_pending_pair_idx
  ON public.lobby_challenge_invitations (
    LEAST(from_user_id, to_user_id),
    GREATEST(from_user_id, to_user_id)
  )
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS lobby_challenge_to_user_pending_idx
  ON public.lobby_challenge_invitations (to_user_id, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS lobby_challenge_lobby_idx
  ON public.lobby_challenge_invitations (lobby_id);
