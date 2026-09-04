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

SELECT cron.schedule(
  'purge-closed-lobbies',
  '10 3 * * *',
  $$DELETE FROM lobbies WHERE id IN (
      SELECT id FROM lobbies
      WHERE status = 'closed' AND created_at < now() - interval '30 days'
      LIMIT 5000
    )$$
);
