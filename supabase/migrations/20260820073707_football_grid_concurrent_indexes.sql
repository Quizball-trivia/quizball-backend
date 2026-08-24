-- Non-concurrent for the prod promotion: the runner's advisory-lock session
-- deadlocks any CONCURRENTLY build (see 20260727130001). Partial predicate
-- keeps the scan short; lock_timeout bounds the SHARE lock on matches.
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS matches_active_game_variant_idx
  ON public.matches (game_variant, updated_at DESC)
  WHERE status = 'active';
