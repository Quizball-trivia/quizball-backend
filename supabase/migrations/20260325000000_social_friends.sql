CREATE TABLE IF NOT EXISTS public.friend_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  receiver_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT friend_requests_sender_receiver_distinct CHECK (sender_user_id <> receiver_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS friend_requests_pending_unique_pair
  ON public.friend_requests (sender_user_id, receiver_user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_friend_requests_sender_status_created
  ON public.friend_requests (sender_user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_friend_requests_receiver_status_created
  ON public.friend_requests (receiver_user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.friendships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_low_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  user_high_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT friendships_user_pair_distinct CHECK (user_low_id <> user_high_id),
  CONSTRAINT friendships_user_pair_order CHECK (user_low_id < user_high_id),
  CONSTRAINT friendships_user_pair_unique UNIQUE (user_low_id, user_high_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_user_low
  ON public.friendships (user_low_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_friendships_user_high
  ON public.friendships (user_high_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_friend_requests_set_updated_at ON public.friend_requests;
CREATE TRIGGER trg_friend_requests_set_updated_at
  BEFORE UPDATE ON public.friend_requests
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();
