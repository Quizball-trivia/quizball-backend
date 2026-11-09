-- Nullable metadata only: preserve existing memberships and avoid a table rewrite.
ALTER TABLE public.lobby_members
  ADD COLUMN IF NOT EXISTS waiting_disconnect_token uuid,
  ADD COLUMN IF NOT EXISTS waiting_disconnect_expires_at timestamptz;
