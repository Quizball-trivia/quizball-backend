-- Standalone online index: no write-blocking index build on lobby membership.
CREATE INDEX CONCURRENTLY IF NOT EXISTS lobby_members_waiting_disconnect_due_idx
  ON public.lobby_members (waiting_disconnect_expires_at)
  WHERE waiting_disconnect_expires_at IS NOT NULL;
