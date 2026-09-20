-- Canonicalize the production-safe function bodies without executing either
-- function, backfilling aggregates, or changing any cron job/activation state.
CREATE OR REPLACE FUNCTION public.purge_closed_lobbies(batch_size integer DEFAULT 5000)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.roll_up_lobby_daily_stats(target_day date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
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
  -- Georgia-local day boundaries. The session TimeZone on prod is UTC, so a
  -- bare target_day::timestamptz would bucket by UTC midnight and shift every
  -- boundary 4 hours — lobbies between 20:00 and 24:00 Georgia time would land
  -- on the wrong day, and the backfill would disagree with the cron.
  WHERE l.created_at >= (target_day::timestamp AT TIME ZONE 'Asia/Tbilisi')
    AND l.created_at < ((target_day + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi')
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
$function$;

REVOKE ALL ON FUNCTION public.roll_up_lobby_daily_stats(date), public.purge_closed_lobbies(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.roll_up_lobby_daily_stats(date), public.purge_closed_lobbies(integer) TO service_role;
