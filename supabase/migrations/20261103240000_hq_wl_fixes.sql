-- QuizBall HQ: Weekend League test tournaments don't count as player activity.
--
-- wl_tournaments.is_test marks ops/load-test tournaments (on staging every
-- Weekend League answer so far — 279k rows — belongs to one). The activity
-- rollup counted their participants as active players; admin-stats now
-- excludes them, and so does the rollup source from here on. Only rollup
-- days that contain test-tournament answers are recomputed (14 days on
-- staging), under the rollup's refresh lock.

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

DO $$
DECLARE
  st hq.activity_rollup_state;
  d date;
  n integer := 0;
BEGIN
  IF to_regclass('public.wl_answers') IS NULL OR to_regclass('public.wl_tournaments') IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hq.activity_days'));
  SELECT * INTO st FROM hq.activity_rollup_state WHERE id;
  IF st.computed_from IS NULL THEN
    RETURN;
  END IF;
  FOR d IN
    SELECT DISTINCT (a.created_at AT TIME ZONE 'Asia/Tbilisi')::date
      FROM public.wl_answers a
      JOIN public.wl_tournaments wt ON wt.id = a.tournament_id AND wt.is_test
     WHERE a.created_at >= (st.computed_from::timestamp AT TIME ZONE 'Asia/Tbilisi')
  LOOP
    PERFORM hq.refresh_activity_days(d, d);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'hq.activity_days: recomputed % day(s) with test-tournament answers', n;
END $$;
