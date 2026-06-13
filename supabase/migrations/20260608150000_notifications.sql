-- In-app notifications: a persistent per-user feed powering the bell badge.
-- Delivered live over Socket.IO (user:${id} rooms) and persisted so users see
-- them on next login. `data` is a flexible jsonb payload keyed by `type`.

CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  type text NOT NULL,
  title jsonb NOT NULL,
  body jsonb,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Feed ordering per user (newest first).
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON public.notifications (user_id, created_at DESC);

-- Fast unread-count lookups.
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON public.notifications (user_id)
  WHERE read_at IS NULL;
