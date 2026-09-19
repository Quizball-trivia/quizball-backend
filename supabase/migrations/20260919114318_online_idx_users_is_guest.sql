-- Build on the shared table without holding a write-blocking table lock.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_is_guest
  ON public.users (created_at)
  WHERE is_guest = true;
