-- Purge closed lobbies older than 30 days, now that lobby_daily_stats
-- (20260904200100) preserves the funnel and matchmaking-wait metrics that are
-- not derivable from `matches`.
--
-- Only 'closed' lobbies are eligible: an open or waiting lobby is live state,
-- and the stranded-lobby heal work depends on being able to find them.
--
-- Children go with the parent by CASCADE (lobby_members, lobby_categories,
-- lobby_category_bans, lobby_challenge_invitations). `matches.lobby_id` is
-- ON DELETE SET NULL, so match history survives the purge — the match keeps
-- its own mode and categories, it just loses the pointer back to the lobby.
-- That FK is indexed as of #634, without which each delete scanned the 413 MB
-- matches table.
--
-- Batched with a subquery LIMIT so a first run over ~78,000 rows cannot hold
-- one long transaction. pg_cron runs it nightly, so the backlog drains over a
-- few nights and the steady state is a few hundred rows per run.

-- Roll up yesterday before anything is deleted. Running at 02:50 and purging at
-- 03:10 leaves a margin, and the rollup is idempotent.
SELECT cron.schedule(
  'roll-up-lobby-daily-stats',
  '50 2 * * *',
  $$SELECT roll_up_lobby_daily_stats((now() AT TIME ZONE 'Asia/Tbilisi')::date - 1)$$
);

-- The purge re-rolls every creation day it is about to touch, then deletes.
-- Two reasons, beyond the nightly rollup already having run:
--   * a day is never purged unless its aggregate exists — the rollup is the
--     only surviving record, so deleting an un-aggregated day loses it for good
--   * a lobby's terminal state can change after its creation day was rolled up
--     (it starts a match, or is abandoned), leaving lobbies_started /
--     lobbies_abandoned stale for that day
-- roll_up_lobby_daily_stats is idempotent, so re-rolling is free and safe.
CREATE OR REPLACE FUNCTION purge_closed_lobbies(batch_size int DEFAULT 5000)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  victims uuid[];
  d date;
  deleted int;
BEGIN
  SELECT array_agg(id) INTO victims
  FROM (
    SELECT id FROM lobbies
    WHERE status = 'closed' AND created_at < now() - interval '30 days'
    LIMIT batch_size
  ) batch;

  IF victims IS NULL THEN
    RETURN 0;
  END IF;

  FOR d IN
    SELECT DISTINCT (created_at AT TIME ZONE 'Asia/Tbilisi')::date
    FROM lobbies WHERE id = ANY(victims)
  LOOP
    PERFORM roll_up_lobby_daily_stats(d);
  END LOOP;

  DELETE FROM lobbies WHERE id = ANY(victims);
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;

REVOKE ALL ON FUNCTION purge_closed_lobbies(int) FROM public, anon, authenticated;

SELECT cron.schedule(
  'purge-closed-lobbies',
  '10 3 * * *',
  $$SELECT purge_closed_lobbies(5000)$$
);
