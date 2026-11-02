-- QuizBall HQ: one definition of "active players" everywhere, and duels count.
--
--   1. hq.pulse (the /hq/pulse KPIs and the standup KPIs) now takes active
--      players per day from the all-surface rollup (registered + guests, same
--      as /hq/analytics and goals) instead of 1v1 matches only. new_users and
--      matches (1v1 matches with a real human, labelled as such) are unchanged.
--   2. hq.activity_source counts duel participants (duel_matches +
--      duel_participants, written by duelRepo.insertMatch). Rollup days that
--      contain duel activity are recomputed (bounded: only those days).
-- An index for duel time windows ships separately (20261103250010).

CREATE OR REPLACE FUNCTION hq.activity_source(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (ident text, user_id uuid, at timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path = hq, public, pg_temp
AS $$
DECLARE
  t text;
  rel regclass;
  has_col boolean;
  q text := $q$
    SELECT 'u:' || mp.user_id::text, mp.user_id, m.started_at
      FROM public.match_players mp
      JOIN public.matches m ON m.id = mp.match_id AND NOT m.is_dev
      JOIN real_users ru ON ru.id = mp.user_id
     WHERE m.started_at >= $1 AND m.started_at < $2$q$;
BEGIN
  IF to_regclass('public.daily_challenge_completions') IS NOT NULL THEN
    q := q || $q$
      UNION ALL SELECT 'u:' || d.user_id::text, d.user_id, d.completed_at
        FROM public.daily_challenge_completions d JOIN real_users ru ON ru.id = d.user_id
       WHERE d.completed_at >= $1 AND d.completed_at < $2$q$;
  END IF;
  IF to_regclass('public.guest_daily_completions') IS NOT NULL THEN
    q := q || $q$
      UNION ALL SELECT 'g:' || g.guest_id::text, NULL::uuid, g.created_at
        FROM public.guest_daily_completions g
       WHERE g.created_at >= $1 AND g.created_at < $2 AND g.guest_id IS NOT NULL$q$;
  END IF;
  -- registered-only rounds: (user_id, created_at)
  -- Weekend League: one identity per participant, test tournaments excluded.
  IF to_regclass('public.wl_answers') IS NOT NULL AND to_regclass('public.wl_tournaments') IS NOT NULL THEN
    q := q || $q$
      UNION ALL SELECT 'u:' || a.user_id::text, a.user_id, a.created_at
        FROM public.wl_answers a
        JOIN real_users ru ON ru.id = a.user_id
        JOIN public.wl_tournaments wt ON wt.id = a.tournament_id AND NOT wt.is_test
       WHERE a.created_at >= $1 AND a.created_at < $2$q$;
  END IF;
  -- Duels (Buscaminas / Pistas head-to-head): each real registered seat, when
  -- the duel started. Guest seats are users.is_guest friend-room accounts,
  -- which no surface counts (matches exclude them too).
  IF to_regclass('public.duel_participants') IS NOT NULL AND to_regclass('public.duel_matches') IS NOT NULL THEN
    q := q || $q$
      UNION ALL SELECT 'u:' || dp.user_id::text, dp.user_id, dm.started_at
        FROM public.duel_matches dm
        JOIN public.duel_participants dp ON dp.match_id = dm.id
        JOIN real_users ru ON ru.id = dp.user_id
       WHERE dm.started_at >= $1 AND dm.started_at < $2$q$;
  END IF;
  FOREACH t IN ARRAY ARRAY['squad_spin_rounds', 'trivia_mines_rounds', 'free_kicks_rounds', 'road_to_goal_rounds'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      q := q || format($f$
        UNION ALL SELECT 'u:' || r.user_id::text, r.user_id, r.created_at
          FROM public.%I r JOIN real_users ru ON ru.id = r.user_id
         WHERE r.created_at >= $1 AND r.created_at < $2$f$, t);
    END IF;
  END LOOP;
  -- user-or-guest surfaces: (user_id, guest_id, created_at)
  FOREACH t IN ARRAY ARRAY['guess_the_goal_sessions', 'ultimo_runs', 'name_chain_runs', 'buscaminas_runs', 'minuto_runs',
                           'pistas_runs', 'conexiones_runs', 'dato_falso_runs', 'codenames_runs', 'tenable_runs',
                           'football_race_runs', 'darts501_runs', 'grid_daily_runs', 'shared_player_runs'] LOOP
    rel := to_regclass('public.' || t);
    IF rel IS NOT NULL THEN
      SELECT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = rel AND a.attname = 'guest_id' AND NOT a.attisdropped)
        INTO has_col;
      q := q || format($f$
        UNION ALL SELECT COALESCE('u:' || r.user_id::text, %s), r.user_id, r.created_at
          FROM public.%I r
         WHERE r.created_at >= $1 AND r.created_at < $2
           AND (r.user_id IS NULL OR r.user_id IN (SELECT id FROM real_users))
           AND (r.user_id IS NOT NULL OR %s)$f$,
        CASE WHEN has_col THEN $c$'g:' || r.guest_id::text$c$ ELSE 'NULL' END, t,
        CASE WHEN has_col THEN 'r.guest_id IS NOT NULL' ELSE 'false' END);
    END IF;
  END LOOP;

  RETURN QUERY EXECUTE
    'WITH real_users AS (
       SELECT id FROM public.users WHERE NOT is_ai AND NOT is_seed AND NOT is_deleted AND NOT is_guest
     ) ' || q
    USING p_from, p_to;
END;
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
    hq.metrics_snapshot(p_days),
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

-- Recompute the rollup days that contain duel activity (they were missing it).
DO $$
DECLARE
  st hq.activity_rollup_state;
  d date;
  n integer := 0;
BEGIN
  IF to_regclass('public.duel_matches') IS NULL OR to_regclass('public.duel_participants') IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hq.activity_days'));
  SELECT * INTO st FROM hq.activity_rollup_state WHERE id;
  IF st.computed_from IS NULL THEN
    RETURN;
  END IF;
  FOR d IN
    SELECT DISTINCT (dm.started_at AT TIME ZONE 'Asia/Tbilisi')::date
      FROM public.duel_matches dm
     WHERE dm.started_at >= (st.computed_from::timestamp AT TIME ZONE 'Asia/Tbilisi')
       AND EXISTS (SELECT 1 FROM public.duel_participants dp WHERE dp.match_id = dm.id)
  LOOP
    PERFORM hq.refresh_activity_days(d, d);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'hq.activity_days: recomputed % day(s) with duel activity', n;
END $$;
