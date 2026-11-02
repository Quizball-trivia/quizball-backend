-- QuizBall HQ: make retention fast on real data, and fix the standup lock order.
--
-- hq.retention_cohorts(16) hit the statement timeout on staging: for every
-- cohort member it ran three correlated EXISTS against a materialised CTE of
-- every play in the window (≈ members × plays comparisons). The rewrite
-- reduces plays to one row per (member, Tbilisi day) once, restricted to
-- people who signed up inside the window, then derives D1/D7/D30 with a single
-- hash join + GROUP BY. Definitions and output are unchanged.

-- Player activity, optionally limited to users who signed up on/after
-- p_signed_up_since (NULL = everyone). Same play surfaces as before; column
-- checks use pg_attribute instead of information_schema (much cheaper).
CREATE FUNCTION hq.user_activity(p_since timestamptz, p_signed_up_since timestamptz)
RETURNS TABLE (user_id uuid, at timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path = hq, public, pg_temp
AS $$
DECLARE
  surface text[];
  rel regclass;
  q text := $q$
    SELECT mp.user_id, m.started_at
      FROM public.match_players mp
      JOIN public.matches m ON m.id = mp.match_id AND NOT m.is_dev
     WHERE m.started_at >= $1 AND mp.user_id IS NOT NULL$q$;
BEGIN
  -- {table, timestamp column}
  FOREACH surface SLICE 1 IN ARRAY ARRAY[
    ['daily_challenge_completions', 'completed_at'],
    ['squad_spin_rounds', 'created_at'],
    ['trivia_mines_rounds', 'created_at'],
    ['free_kicks_rounds', 'created_at'],
    ['road_to_goal_rounds', 'created_at'],
    ['guess_the_goal_sessions', 'created_at'],
    ['wl_answers', 'created_at'],
    ['ultimo_runs', 'created_at'],
    ['name_chain_runs', 'created_at'],
    ['buscaminas_runs', 'created_at'],
    ['minuto_runs', 'created_at'],
    ['pistas_runs', 'created_at'],
    ['conexiones_runs', 'created_at'],
    ['dato_falso_runs', 'created_at'],
    ['codenames_runs', 'created_at'],
    ['tenable_runs', 'created_at'],
    ['football_race_runs', 'created_at'],
    ['darts501_runs', 'created_at'],
    ['grid_daily_runs', 'created_at'],
    ['shared_player_runs', 'created_at']
  ]
  LOOP
    rel := to_regclass('public.' || surface[1]);
    IF rel IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = rel AND a.attname = 'user_id' AND NOT a.attisdropped)
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = rel AND a.attname = surface[2] AND NOT a.attisdropped) THEN
      q := q || format(
        ' UNION ALL SELECT s.user_id, s.%I FROM public.%I s WHERE s.%I >= $1 AND s.user_id IS NOT NULL',
        surface[2], surface[1], surface[2]);
    END IF;
  END LOOP;

  RETURN QUERY EXECUTE
    'SELECT a.user_id, a.at FROM (' || q || ') a(user_id, at)
       JOIN public.users u ON u.id = a.user_id
      WHERE NOT u.is_ai AND NOT u.is_seed AND NOT u.is_guest AND NOT u.is_deleted
        AND ($2 IS NULL OR u.created_at >= $2)'
    USING p_since, p_signed_up_since;
END;
$$;

-- The one-argument form keeps its contract (used by hq.analytics_snapshot).
CREATE OR REPLACE FUNCTION hq.user_activity(p_since timestamptz)
RETURNS TABLE (user_id uuid, at timestamptz)
LANGUAGE sql
STABLE
SET search_path = hq, public, pg_temp
AS $$
  SELECT a.user_id, a.at FROM hq.user_activity(p_since, NULL::timestamptz) a;
$$;

-- Same output and definitions as before (see 20261103090000_hq_standup_goals):
-- weekly signup cohorts, d1 = day S+1, d7 = days S+7…S+13, d30 = days
-- S+30…S+59, NULL until the window has elapsed for the cohort's last signup day.
CREATE OR REPLACE FUNCTION hq.retention_cohorts(p_weeks integer DEFAULT 8)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = hq, public, pg_temp
AS $$
  WITH bounds AS (
    SELECT today,
           first_week,
           (first_week::timestamp AT TIME ZONE 'Asia/Tbilisi') AS since
      FROM (
        SELECT (now() AT TIME ZONE 'Asia/Tbilisi')::date AS today,
               date_trunc('week', (now() AT TIME ZONE 'Asia/Tbilisi'))::date
                 - (LEAST(GREATEST(p_weeks, 1), 26) - 1) * 7 AS first_week
      ) p
  ),
  cohort_users AS MATERIALIZED (
    SELECT u.id,
           (u.created_at AT TIME ZONE 'Asia/Tbilisi')::date AS signup_day,
           date_trunc('week', (u.created_at AT TIME ZONE 'Asia/Tbilisi'))::date AS cohort_start
      FROM public.users u, bounds b
     WHERE NOT u.is_ai AND NOT u.is_seed AND NOT u.is_guest AND NOT u.is_deleted
       AND u.created_at >= b.since
  ),
  -- One row per (member, Tbilisi day) they played, members only.
  play_days AS MATERIALIZED (
    SELECT a.user_id, (a.at AT TIME ZONE 'Asia/Tbilisi')::date AS day
      FROM bounds b, hq.user_activity(b.since, b.since) a
     GROUP BY 1, 2
  ),
  per_user AS (
    SELECT cu.cohort_start,
           COALESCE(bool_or(pd.day = cu.signup_day + 1), false) AS r1,
           COALESCE(bool_or(pd.day BETWEEN cu.signup_day + 7 AND cu.signup_day + 13), false) AS r7,
           COALESCE(bool_or(pd.day BETWEEN cu.signup_day + 30 AND cu.signup_day + 59), false) AS r30
      FROM cohort_users cu
      LEFT JOIN play_days pd ON pd.user_id = cu.id
     GROUP BY cu.id, cu.cohort_start
  ),
  cohorts AS (
    SELECT cohort_start, count(*) AS size,
           count(*) FILTER (WHERE r1) AS r1, count(*) FILTER (WHERE r7) AS r7, count(*) FILTER (WHERE r30) AS r30
      FROM per_user GROUP BY cohort_start
  ),
  weeks AS (
    SELECT generate_series(b.first_week, date_trunc('week', b.today::timestamp)::date, interval '7 days')::date AS cohort_start,
           b.today
      FROM bounds b
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'cohort_start', w.cohort_start::text,
           'size', COALESCE(c.size, 0),
           'd1',  CASE WHEN w.today > w.cohort_start + 6 + 1  AND c.size > 0 THEN round(c.r1::numeric / c.size, 3) END,
           'd7',  CASE WHEN w.today > w.cohort_start + 6 + 13 AND c.size > 0 THEN round(c.r7::numeric / c.size, 3) END,
           'd30', CASE WHEN w.today > w.cohort_start + 6 + 59 AND c.size > 0 THEN round(c.r30::numeric / c.size, 3) END
         ) ORDER BY w.cohort_start), '[]'::jsonb)
    FROM weeks w
    LEFT JOIN cohorts c ON c.cohort_start = w.cohort_start;
$$;

-- Lock order: the standup path takes the 'hq.standup_run' advisory lock
-- BEFORE touching the schedule row — same order as POST /standup/run and
-- POST /schedules/:id/run-now — so the paths can't deadlock. task_kind is read
-- without a lock first to decide whether the advisory lock is needed.
CREATE OR REPLACE FUNCTION hq.fire_schedule(
  p_schedule_id uuid,
  p_expected_next timestamptz,
  p_new_next timestamptz,
  p_title text
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  s hq.schedules;
  v_kind text;
  v_task uuid;
  v_today date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
BEGIN
  SELECT task_kind INTO v_kind FROM hq.schedules WHERE id = p_schedule_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_kind = 'standup' THEN
    PERFORM pg_advisory_xact_lock(hashtext('hq.standup_run'));
  END IF;

  UPDATE hq.schedules
     SET next_run_at = p_new_next, last_run_at = now(), updated_at = now()
   WHERE id = p_schedule_id AND enabled AND next_run_at = p_expected_next
  RETURNING * INTO s;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF s.task_kind = 'standup' THEN
    IF v_kind IS DISTINCT FROM 'standup' THEN
      -- The kind flipped to standup between the read and the update: take the
      -- lock now (rare; ordering only matters for concurrent standup paths).
      PERFORM pg_advisory_xact_lock(hashtext('hq.standup_run'));
    END IF;
    IF hq.has_standup_today(s.member_id, v_today) THEN
      INSERT INTO hq.events (type, member_id, message, data)
      VALUES ('standup_skipped', s.member_id, 'Schedule "' || s.name || '" skipped: today''s standup already exists',
              jsonb_build_object('schedule_id', s.id, 'slot', p_expected_next, 'date', v_today));
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO hq.tasks (title, body, status, kind, assignee_id, schedule_id)
  VALUES (left(p_title, 200), s.task_body, 'todo', s.task_kind, s.member_id, s.id)
  RETURNING id INTO v_task;

  UPDATE hq.schedules SET last_task_id = v_task WHERE id = s.id;

  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES ('schedule_fired', s.member_id, v_task, 'Schedule "' || s.name || '" created a task',
          jsonb_build_object('schedule_id', s.id, 'slot', p_expected_next, 'kind', s.task_kind));
  RETURN v_task;
END;
$$;

REVOKE ALL ON FUNCTION hq.user_activity(timestamptz, timestamptz) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.user_activity(timestamptz, timestamptz) TO service_role';
  END IF;
END $$;
