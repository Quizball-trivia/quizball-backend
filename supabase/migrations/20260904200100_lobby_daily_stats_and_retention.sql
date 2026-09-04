-- Closed lobbies are never deleted. All 106,806 rows on prod are
-- status='closed', oldest 2026-02-05, and 78% are older than 30 days. With
-- children that is ~121 MB (lobby_categories 55 MB, lobby_category_bans 34 MB,
-- lobbies 32 MB) of matchmaking scaffolding that nothing reads: a grep found no
-- query that reads closed lobbies by age, and only per-lobby deletes exist
-- (lobbies.repo.ts:264).
--
-- WHAT WOULD BE LOST, and why most of it would not be:
--   * outcome            — already on `matches`, which keeps lobby_id
--                          (106,607 of 119,048 matches carry it)
--   * mode, categories   — already columns on `matches`
--   * abandoned lobbies  — only 249 of 106,807 (0.2%) never produced a match
--   * matchmaking wait   — NOT derivable once the lobby is gone. It needs
--                          lobbies.created_at together with matches.started_at,
--                          and it is a genuinely useful health metric
--                          (currently averaging 22.5s over the last 7 days).
--   * game_mode, is_public, friendly_random — only on the lobby.
--
-- So roll the useful parts into a small daily aggregate before deleting. One
-- row per (day, mode, game_mode) instead of ~600 lobbies/day: the fill below
-- produces a few hundred rows for seven months of history.

CREATE TABLE IF NOT EXISTS lobby_daily_stats (
  day date NOT NULL,
  mode text NOT NULL,
  game_mode text NOT NULL,
  lobbies_created int NOT NULL DEFAULT 0,
  lobbies_started int NOT NULL DEFAULT 0,
  lobbies_abandoned int NOT NULL DEFAULT 0,
  public_lobbies int NOT NULL DEFAULT 0,
  random_category_lobbies int NOT NULL DEFAULT 0,
  avg_wait_seconds numeric(10,2),
  p95_wait_seconds numeric(10,2),
  PRIMARY KEY (day, mode, game_mode)
);

COMMENT ON TABLE lobby_daily_stats IS
  'Daily rollup of lobby funnel + matchmaking wait, so closed lobbies can be purged after 30 days without losing the only metrics that are not derivable from `matches`.';

ALTER TABLE lobby_daily_stats ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: deny-all for anon/authenticated; the backend's
-- service role bypasses RLS. Mirrors 20260702000000_enable_rls_all_public_tables.

-- Aggregate one day of lobbies. Idempotent, so the cron can re-run and a
-- backfill can call it for any date.
CREATE OR REPLACE FUNCTION roll_up_lobby_daily_stats(target_day date)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  affected int;
BEGIN
  INSERT INTO lobby_daily_stats AS s (
    day, mode, game_mode, lobbies_created, lobbies_started, lobbies_abandoned,
    public_lobbies, random_category_lobbies, avg_wait_seconds, p95_wait_seconds
  )
  SELECT
    target_day,
    l.mode,
    coalesce(l.game_mode, 'unknown'),
    count(*)::int,
    count(*) FILTER (WHERE m.id IS NOT NULL)::int,
    count(*) FILTER (WHERE m.id IS NULL)::int,
    count(*) FILTER (WHERE l.is_public)::int,
    count(*) FILTER (WHERE l.friendly_random)::int,
    round(avg(EXTRACT(epoch FROM m.started_at - l.created_at))::numeric, 2),
    round(percentile_cont(0.95) WITHIN GROUP (
      ORDER BY EXTRACT(epoch FROM m.started_at - l.created_at)
    )::numeric, 2)
  FROM lobbies l
  LEFT JOIN LATERAL (
    SELECT m.id, m.started_at
    FROM matches m
    WHERE m.lobby_id = l.id AND m.started_at IS NOT NULL
    ORDER BY m.started_at
    LIMIT 1
  ) m ON true
  WHERE l.created_at >= target_day::timestamptz
    AND l.created_at < (target_day + 1)::timestamptz
  GROUP BY l.mode, coalesce(l.game_mode, 'unknown')
  ON CONFLICT (day, mode, game_mode) DO UPDATE SET
    lobbies_created = excluded.lobbies_created,
    lobbies_started = excluded.lobbies_started,
    lobbies_abandoned = excluded.lobbies_abandoned,
    public_lobbies = excluded.public_lobbies,
    random_category_lobbies = excluded.random_category_lobbies,
    avg_wait_seconds = excluded.avg_wait_seconds,
    p95_wait_seconds = excluded.p95_wait_seconds;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION roll_up_lobby_daily_stats(date) FROM public, anon, authenticated;

-- Backfill every day that already has lobbies, so nothing is lost when the
-- purge below first runs.
DO $$
DECLARE
  d date;
BEGIN
  FOR d IN
    SELECT DISTINCT created_at::date FROM lobbies ORDER BY 1
  LOOP
    PERFORM roll_up_lobby_daily_stats(d);
  END LOOP;
END $$;
