-- Guest friend lobbies: signed-out visitors who play in a friend room become a
-- real users row (every lobby / match / seat table keys on users.id) flagged
-- is_guest. The flag gates every reward, leaderboard and social path.
--
-- NOT CONCURRENTLY: the migration runner holds pg_advisory_xact_lock inside a
-- transaction for the whole run (see 20260904180000). lock_timeout bounds the
-- wait so a deploy never hangs behind a long writer.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_guest boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_is_guest
  ON public.users (created_at)
  WHERE is_guest = true;

COMMENT ON COLUMN public.users.is_guest IS
  'Account-less guest playing friend rooms: no coins/tickets/RP/XP/streaks/leaderboards/social. Tombstoned, never deleted.';
