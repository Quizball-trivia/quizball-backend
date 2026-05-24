-- Hide seeded fake leaderboard users without deleting them.
-- Adds an is_seed flag so the cleanup_ai_users() cron can't reach them,
-- and disables the cron that nudges their RP every 4 hours.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_seed boolean NOT NULL DEFAULT false;

-- Backfill: seed-user identity = is_ai = false AND no user_identities row.
UPDATE public.users u
SET is_seed = true
WHERE u.is_ai = false
  AND NOT EXISTS (
    SELECT 1 FROM public.user_identities ui WHERE ui.user_id = u.id
  );

CREATE INDEX IF NOT EXISTS idx_users_is_seed ON public.users (id) WHERE is_seed = true;

-- Disable the cron that randomly nudges fake-user RP every 4h.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'simulate-leaderboard-movement') THEN
    PERFORM cron.unschedule('simulate-leaderboard-movement');
  END IF;
END $$;
