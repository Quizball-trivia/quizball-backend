-- QuizBall HQ: cheaper KPI queries (pg_stat_statements on prod, Nov 2–9:
-- hq.pulse = 769 calls × 600 ms, 462 s — ~10× every other HQ query combined).
--
--   1. hq.metrics_snapshot keeps its output but finds "real" matches from the
--      window's players instead of semi-joining every match_players row with
--      every real user (prod: 535 ms → 330 ms for 14 days, same counts).
--   2. hq.pulse no longer asks for the three fields it never returns or
--      overwrites (active_players_by_day from matches, matches_by_mode,
--      matches_by_status): it reads hq.metrics_core, the same numbers minus
--      those.

CREATE OR REPLACE FUNCTION hq.metrics_core(p_days integer DEFAULT 7, p_full boolean DEFAULT false)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = hq, public, pg_temp
AS $$
  WITH win AS (
    SELECT now() - make_interval(days => LEAST(GREATEST(p_days, 1), 90)) AS since
  ),
  real_users AS (
    SELECT u.id, u.created_at
      FROM public.users u
     WHERE NOT u.is_ai AND NOT u.is_seed AND NOT u.is_guest AND NOT u.is_deleted
  ),
  -- Real players of non-dev matches in the window. Bot-only matches (bot
  -- burn-in is written with is_dev = false) have no row here, so a match counts
  -- only with at least one real player, like adminStatsRepo.gamesPerDay().
  real_players AS MATERIALIZED (
    SELECT m.id, m.mode, m.status, m.started_at, mp.user_id
      FROM public.matches m
      JOIN public.match_players mp ON mp.match_id = m.id
      JOIN real_users ru ON ru.id = mp.user_id, win
     WHERE NOT m.is_dev
       AND m.started_at >= win.since
  ),
  real_matches AS MATERIALIZED (
    SELECT DISTINCT id, mode, status, started_at FROM real_players
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'timezone', 'Asia/Tbilisi',
    'days', LEAST(GREATEST(p_days, 1), 90),
    'total_registered_users', (SELECT count(*) FROM real_users),
    'new_users_by_day', COALESCE((
      SELECT jsonb_object_agg(day, n) FROM (
        SELECT (ru.created_at AT TIME ZONE 'Asia/Tbilisi')::date::text AS day, count(*) AS n
          FROM real_users ru, win WHERE ru.created_at >= win.since GROUP BY 1
      ) s), '{}'::jsonb),
    'matches_by_day', COALESCE((
      SELECT jsonb_object_agg(day, n) FROM (
        SELECT (rm.started_at AT TIME ZONE 'Asia/Tbilisi')::date::text AS day, count(*) AS n
          FROM real_matches rm GROUP BY 1
      ) s), '{}'::jsonb)
  ) || CASE WHEN p_full THEN jsonb_build_object(
    'matches_by_mode', COALESCE((
      SELECT jsonb_object_agg(mode, n) FROM (
        SELECT rm.mode, count(*) AS n FROM real_matches rm GROUP BY 1
      ) s), '{}'::jsonb),
    'matches_by_status', COALESCE((
      SELECT jsonb_object_agg(status, n) FROM (
        SELECT rm.status, count(*) AS n FROM real_matches rm GROUP BY 1
      ) s), '{}'::jsonb),
    'active_players_by_day', COALESCE((
      SELECT jsonb_object_agg(day, n) FROM (
        SELECT (rp.started_at AT TIME ZONE 'Asia/Tbilisi')::date::text AS day,
               count(DISTINCT rp.user_id) AS n
          FROM real_players rp
         GROUP BY 1
      ) s), '{}'::jsonb)
  ) ELSE '{}'::jsonb END;
$$;

-- Same output as before (the agents' hq_metrics tool reads it).
CREATE OR REPLACE FUNCTION hq.metrics_snapshot(p_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = hq, public, pg_temp
AS $$
  SELECT hq.metrics_core(p_days, true);
$$;

CREATE OR REPLACE FUNCTION hq.pulse(p_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = hq, public, pg_temp
AS $$
DECLARE
  v_days integer := LEAST(GREATEST(p_days, 1), 90);
  v_today date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
  v_first date;
  v_metrics jsonb;
BEGIN
  v_first := v_today - (v_days - 1);
  PERFORM hq.ensure_activity_days(v_first);
  PERFORM hq.assert_activity_covered(v_first);
  v_metrics := jsonb_set(
    hq.metrics_core(p_days, false),
    '{active_players_by_day}',
    COALESCE((
      SELECT jsonb_object_agg(day::text, n)
        FROM (
          SELECT ad.day, count(*) AS n
            FROM hq.activity_days ad
            LEFT JOIN public.users u
              ON u.id = ad.user_id AND NOT u.is_ai AND NOT u.is_seed AND NOT u.is_guest AND NOT u.is_deleted
           WHERE ad.day >= v_first AND (ad.user_id IS NULL OR u.id IS NOT NULL)
           GROUP BY ad.day
        ) s
    ), '{}'::jsonb));
  RETURN jsonb_build_object(
    'metrics', v_metrics,
    'feedback', (
      SELECT jsonb_build_object(
        'count_7d',           count(*) FILTER (WHERE g.updated_at >= now() - interval '7 days'),
        'avg_rating_7d',      round(avg(g.rating) FILTER (WHERE g.updated_at >= now() - interval '7 days'), 2),
        'low_ratings_7d',     count(*) FILTER (WHERE g.updated_at >= now() - interval '7 days' AND g.rating <= 2),
        'count_prev_7d',      count(*) FILTER (WHERE g.updated_at < now() - interval '7 days'),
        'avg_rating_prev_7d', round(avg(g.rating) FILTER (WHERE g.updated_at < now() - interval '7 days'), 2)
      )
      FROM public.game_feedback g
      WHERE g.updated_at >= now() - interval '14 days'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION hq.metrics_core(integer, boolean) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.metrics_core(integer, boolean) TO service_role';
  END IF;
END;
$$;
