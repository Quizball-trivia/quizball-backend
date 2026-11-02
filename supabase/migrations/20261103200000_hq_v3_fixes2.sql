-- QuizBall HQ v3 fixes, round 2 (everything through 20261103180070 is applied).
--
--   1. One live standup per agent: before creating today's standup, older
--      outstanding standup tasks are superseded (cancelled with a system
--      message); an in-progress one means the agent already has a standup.
--      Shared by hq.fire_schedule, POST /standup/run (hq.create_standup_tasks)
--      and POST /schedules/:id/run-now via hq.prepare_standup().
--   2. Rollup readers re-apply current real-user eligibility to registered
--      identities.
--   3. At most one standup schedule per agent (unique index), so creating it
--      is idempotent under concurrency.

-- ── 3. one standup schedule per agent ─────────────────────────────────────
DELETE FROM hq.schedules s
 USING hq.schedules keep
 WHERE s.task_kind = 'standup' AND keep.task_kind = 'standup'
   AND s.member_id = keep.member_id
   AND (keep.created_at, keep.id) < (s.created_at, s.id);
CREATE UNIQUE INDEX hq_schedules_one_standup_per_member ON hq.schedules (member_id) WHERE task_kind = 'standup';

-- ── 1. standup guard ──────────────────────────────────────────────────────
-- True when the member already has a standup for p_date: a report for it, a
-- (non-cancelled) standup task created that Tbilisi day, or any standup task
-- currently in progress.
CREATE OR REPLACE FUNCTION hq.has_standup_today(p_member uuid, p_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = hq, pg_temp
AS $$
  SELECT EXISTS (
           SELECT 1 FROM hq.standups st WHERE st.member_id = p_member AND st.standup_date = p_date)
      OR EXISTS (
           SELECT 1 FROM hq.tasks x
            WHERE x.assignee_id = p_member AND x.kind = 'standup'
              AND (x.status = 'in_progress'
                   OR (x.status <> 'cancelled'
                       AND x.created_at >= (p_date::timestamp AT TIME ZONE 'Asia/Tbilisi')
                       AND x.created_at < ((p_date + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi'))));
$$;

-- Call while holding the 'hq.standup_run' advisory lock. Returns true when a
-- standup task may be created for p_date; in that case older outstanding
-- standup tasks of the member (todo / backlog / blocked, created before p_date)
-- have just been cancelled with a "Superseded by today's standup" message.
CREATE FUNCTION hq.prepare_standup(p_member uuid, p_date date)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
BEGIN
  IF hq.has_standup_today(p_member, p_date) THEN
    RETURN false;
  END IF;

  WITH superseded AS (
    UPDATE hq.tasks t
       SET status = 'cancelled', completed_at = now(),
           claimed_by = NULL, claimed_at = NULL, claim_token = NULL, updated_at = now()
     WHERE t.assignee_id = p_member AND t.kind = 'standup'
       AND t.status IN ('todo', 'backlog', 'blocked')
       AND t.created_at < (p_date::timestamp AT TIME ZONE 'Asia/Tbilisi')
    RETURNING t.id
  ), msg AS (
    INSERT INTO hq.messages (task_id, kind, body)
    SELECT id, 'system', 'Superseded by today''s standup' FROM superseded
    RETURNING task_id
  )
  INSERT INTO hq.events (type, member_id, task_id, message, data)
  SELECT 'standup_superseded', p_member, task_id, 'An unfinished standup was superseded by today''s',
         jsonb_build_object('date', p_date)
    FROM msg;
  RETURN true;
END;
$$;

-- POST /standup/run: today's standup task for every active HQ agent that
-- doesn't have one. Serialised with the other standup paths.
CREATE FUNCTION hq.create_standup_tasks(p_date date, p_created_by uuid)
RETURNS integer
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  m record;
  v_task uuid;
  n integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('hq.standup_run'));
  FOR m IN
    SELECT id FROM hq.members
     WHERE kind = 'agent' AND runtime = 'hq' AND status = 'active'
     ORDER BY name
  LOOP
    IF hq.prepare_standup(m.id, p_date) THEN
      INSERT INTO hq.tasks (title, body, status, kind, priority, assignee_id, created_by_id)
      VALUES ('Daily standup',
              'Morning standup: report yesterday / today / blockers and propose up to 3 ideas that move the goals.',
              'todo', 'standup', 1, m.id, p_created_by)
      RETURNING id INTO v_task;
      INSERT INTO hq.events (type, member_id, task_id, message, data)
      VALUES ('standup_requested', p_created_by, v_task, 'Standup requested', jsonb_build_object('date', p_date::text));
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END;
$$;

-- Same contract and lock order as 20261103150000; the standup check now uses
-- hq.prepare_standup (supersedes stale standups, respects in-progress ones).
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
      PERFORM pg_advisory_xact_lock(hashtext('hq.standup_run'));
    END IF;
    IF NOT hq.prepare_standup(s.member_id, v_today) THEN
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

-- ── 2. eligibility on rollup reads ────────────────────────────────────────
CREATE OR REPLACE FUNCTION hq.active_identities_between(p_from date, p_to date)
RETURNS integer
LANGUAGE plpgsql
SET search_path = hq, public, pg_temp
AS $$
BEGIN
  PERFORM hq.ensure_activity_days(p_from);
  RETURN (
    SELECT count(DISTINCT ad.ident)
      FROM hq.activity_days ad
      LEFT JOIN public.users u
        ON u.id = ad.user_id AND NOT u.is_ai AND NOT u.is_seed AND NOT u.is_guest AND NOT u.is_deleted
     WHERE ad.day BETWEEN p_from AND p_to
       AND (ad.user_id IS NULL OR u.id IS NOT NULL)
  );
END;
$$;

CREATE OR REPLACE FUNCTION hq.analytics_snapshot(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = hq, public, pg_temp
AS $$
DECLARE
  v_days integer := LEAST(GREATEST(p_days, 1), 90);
  v_today date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
  v_first date := v_today - (LEAST(GREATEST(p_days, 1), 90) - 1);
BEGIN
  PERFORM hq.ensure_activity_days(LEAST(v_first, v_today - 29));
  RETURN (
    WITH real_users AS (
      SELECT u.id, u.country, u.created_at
        FROM public.users u
       WHERE NOT u.is_ai AND NOT u.is_seed AND NOT u.is_guest AND NOT u.is_deleted
    ),
    -- Re-apply today's eligibility to registered identities (an account
    -- deleted or flagged since the day was rolled up stops counting); guests
    -- ('g:' rows, user_id NULL) are unaffected.
    activity AS (
      SELECT ad.day, ad.ident, ad.user_id
        FROM hq.activity_days ad
        LEFT JOIN real_users ru ON ru.id = ad.user_id
       WHERE ad.day >= LEAST(v_first, v_today - 29)
         AND (ad.user_id IS NULL OR ru.id IS NOT NULL)
    ),
    human_matches AS (
      SELECT (m.started_at AT TIME ZONE 'Asia/Tbilisi')::date AS day,
             CASE
               WHEN m.game_variant = 'football_grid' THEN 'grid'
               WHEN m.game_variant = 'friendly_party_quiz' THEN 'party_quiz'
               WHEN m.mode = 'auction' THEN 'auction'
               WHEN m.mode = 'ranked' THEN 'ranked'
               ELSE 'friendly'
             END AS mode
        FROM public.matches m
       WHERE NOT m.is_dev
         AND m.started_at >= (v_first::timestamp AT TIME ZONE 'Asia/Tbilisi')
         AND EXISTS (SELECT 1 FROM public.match_players mp JOIN real_users ru ON ru.id = mp.user_id
                      WHERE mp.match_id = m.id)
    ),
    days AS (SELECT generate_series(v_first, v_today, interval '1 day')::date AS day),
    new_by_day AS (
      SELECT (ru.created_at AT TIME ZONE 'Asia/Tbilisi')::date AS day, count(*) AS n
        FROM real_users ru
       WHERE ru.created_at >= (v_first::timestamp AT TIME ZONE 'Asia/Tbilisi')
       GROUP BY 1
    ),
    active_by_day AS (
      SELECT day, count(*) FILTER (WHERE user_id IS NOT NULL) AS registered, count(*) AS all_idents
        FROM activity WHERE day >= v_first GROUP BY day
    ),
    matches_by_day AS (SELECT day, count(*) AS n FROM human_matches GROUP BY day)
    SELECT jsonb_build_object(
      'generated_at', now(),
      'timezone', 'Asia/Tbilisi',
      'days', v_days,
      'total_registered_users', (SELECT count(*) FROM real_users),
      'series', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'date', d.day::text,
                 'new_users', COALESCE(nu.n, 0),
                 'active_players', COALESCE(ap.registered, 0),
                 'active_all', COALESCE(ap.all_idents, 0),
                 'matches', COALESCE(mt.n, 0)
               ) ORDER BY d.day), '[]'::jsonb)
          FROM days d
          LEFT JOIN new_by_day nu ON nu.day = d.day
          LEFT JOIN active_by_day ap ON ap.day = d.day
          LEFT JOIN matches_by_day mt ON mt.day = d.day
      ),
      'actives', (
        SELECT jsonb_build_object(
          'dau', count(DISTINCT a.user_id) FILTER (WHERE a.day = v_today),
          'wau', count(DISTINCT a.user_id) FILTER (WHERE a.day > v_today - 7),
          'mau', count(DISTINCT a.user_id) FILTER (WHERE a.day > v_today - 30)
        ) FROM activity a WHERE a.user_id IS NOT NULL
      ),
      'actives_all', (
        SELECT jsonb_build_object(
          'dau', count(DISTINCT a.ident) FILTER (WHERE a.day = v_today),
          'wau', count(DISTINCT a.ident) FILTER (WHERE a.day > v_today - 7),
          'mau', count(DISTINCT a.ident) FILTER (WHERE a.day > v_today - 30)
        ) FROM activity a
      ),
      'modes', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('mode', mode, 'matches', n) ORDER BY n DESC, mode)
          FROM (SELECT mode, count(*) AS n FROM human_matches GROUP BY mode) s
      ), '[]'::jsonb),
      'modes_by_day', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('date', day::text, 'mode', mode, 'matches', n) ORDER BY day, mode)
          FROM (SELECT day, mode, count(*) AS n FROM human_matches GROUP BY day, mode) s
      ), '[]'::jsonb),
      'countries', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('country', country, 'players', players, 'registered', registered)
                         ORDER BY players DESC, registered DESC, country)
          FROM (
            SELECT COALESCE(NULLIF(ru.country, ''), 'unknown') AS country,
                   count(*) FILTER (WHERE ap.user_id IS NOT NULL) AS players,
                   count(*) AS registered
              FROM real_users ru
              LEFT JOIN (SELECT DISTINCT a.user_id FROM activity a WHERE a.day >= v_first AND a.user_id IS NOT NULL) ap
                ON ap.user_id = ru.id
             GROUP BY 1
          ) c
      ), '[]'::jsonb)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION hq.prepare_standup(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.create_standup_tasks(date, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.prepare_standup(uuid, date) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.create_standup_tasks(date, uuid) TO service_role';
  END IF;
END $$;
