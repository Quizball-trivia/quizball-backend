-- QuizBall HQ v3: goals, the daily standup, proposals and analytics.
--
--   goals      company goals at three horizons (north_star / week / day),
--              optionally tied to a metric so progress is automatic
--   standups   one report per agent per Tbilisi day (headline, yesterday,
--              today, blockers), written by the agent's standup task
--   tasks      + kind ('task' | 'standup' | 'proposal'), goal_id, proposal
--              jsonb, and the new status 'proposed' (an idea waiting for the
--              CEO — never claimed by the worker until accepted → 'todo')
--   schedules  + task_kind, copied into the task by hq.fire_schedule
--
-- Plus two read-only analytics functions (hq.retention_cohorts,
-- hq.analytics_snapshot) built on hq.user_activity(), which unions every play
-- surface we record for registered players.

-- ── goals ──────────────────────────────────────────────────────────────────
CREATE TABLE hq.goals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  horizon          text NOT NULL CONSTRAINT hq_goals_horizon CHECK (horizon IN ('north_star', 'week', 'day')),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description      text NOT NULL DEFAULT '',
  -- When set, progress is computed by the backend from analytics over the
  -- goal's period; otherwise manual_progress (0–100) is the progress.
  metric           text CONSTRAINT hq_goals_metric
                   CHECK (metric IN ('new_users', 'active_players', 'matches', 'd7_retention', 'avg_rating')),
  target           numeric CHECK (target > 0),
  manual_progress  smallint CHECK (manual_progress BETWEEN 0 AND 100),
  -- Tbilisi calendar dates, inclusive.
  period_start     date NOT NULL,
  period_end       date NOT NULL,
  status           text NOT NULL DEFAULT 'active' CONSTRAINT hq_goals_status CHECK (status IN ('active', 'achieved', 'dropped')),
  department       text CONSTRAINT hq_goals_department
                   CHECK (department IN ('leadership', 'growth', 'content', 'competitions', 'engineering', 'partners')),
  position         double precision NOT NULL DEFAULT extract(epoch FROM now()),
  created_by_id    uuid REFERENCES hq.members(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hq_goals_period CHECK (period_end >= period_start),
  CONSTRAINT hq_goals_metric_target CHECK (metric IS NULL OR target IS NOT NULL)
);
-- The company has one North Star at a time.
CREATE UNIQUE INDEX hq_goals_one_active_north_star ON hq.goals (horizon)
  WHERE horizon = 'north_star' AND status = 'active';
CREATE INDEX hq_goals_active_idx ON hq.goals (horizon, period_start) WHERE status = 'active';

-- ── standups ───────────────────────────────────────────────────────────────
CREATE TABLE hq.standups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     uuid NOT NULL REFERENCES hq.members(id) ON DELETE CASCADE,
  standup_date  date NOT NULL,
  headline      text NOT NULL CHECK (length(headline) BETWEEN 1 AND 300),
  yesterday     text NOT NULL DEFAULT '',
  today         text NOT NULL DEFAULT '',
  blockers      text NOT NULL DEFAULT '',
  task_id       uuid REFERENCES hq.tasks(id) ON DELETE SET NULL,
  run_id        uuid REFERENCES hq.runs(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hq_standups_one_per_day UNIQUE (member_id, standup_date)
);
CREATE INDEX hq_standups_date_idx ON hq.standups (standup_date);

-- ── tasks: kind, goal link, proposals ─────────────────────────────────────
ALTER TABLE hq.tasks
  ADD COLUMN kind text NOT NULL DEFAULT 'task'
    CONSTRAINT hq_tasks_kind CHECK (kind IN ('task', 'standup', 'proposal')),
  ADD COLUMN goal_id uuid REFERENCES hq.goals(id) ON DELETE SET NULL,
  -- { why, plan, expectedImpact, effort: 's'|'m'|'l' } for kind = 'proposal'
  ADD COLUMN proposal jsonb;

ALTER TABLE hq.tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE hq.tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('backlog', 'todo', 'in_progress', 'needs_approval', 'blocked', 'done', 'cancelled', 'proposed'));

CREATE INDEX hq_tasks_proposed_idx ON hq.tasks (created_at DESC) WHERE status = 'proposed';
-- One open proposal per (assignee, title): the worker treats a 23505 on insert
-- as "already proposed".
CREATE UNIQUE INDEX hq_tasks_open_proposal_unique ON hq.tasks (assignee_id, lower(title)) WHERE status = 'proposed';
CREATE INDEX hq_tasks_kind_idx ON hq.tasks (kind, created_at DESC) WHERE kind <> 'task';
CREATE INDEX hq_tasks_goal_idx ON hq.tasks (goal_id) WHERE goal_id IS NOT NULL;
-- hq.claim_next_task only selects status = 'todo', so 'proposed' tasks are
-- never claimed until a human accepts them.

-- ── schedules: task kind ──────────────────────────────────────────────────
ALTER TABLE hq.schedules
  ADD COLUMN task_kind text NOT NULL DEFAULT 'task'
    CONSTRAINT hq_schedules_task_kind CHECK (task_kind IN ('task', 'standup'));

-- Same contract as before; now copies the schedule's task_kind.
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
  v_task uuid;
BEGIN
  UPDATE hq.schedules
     SET next_run_at = p_new_next, last_run_at = now(), updated_at = now()
   WHERE id = p_schedule_id AND enabled AND next_run_at = p_expected_next
  RETURNING * INTO s;
  IF NOT FOUND THEN
    RETURN NULL;
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

-- ── player activity (registered players, every play surface) ─────────────
-- One row per play by a real registered user since p_since: multiplayer
-- matches (non-dev) plus every single-player/daily surface that records
-- (user_id, timestamp). Mirrors the play surfaces admin-stats counts; tables
-- that don't exist in an environment are skipped, so this never breaks when a
-- game is added or removed — add new surfaces to the list below.
CREATE FUNCTION hq.user_activity(p_since timestamptz)
RETURNS TABLE (user_id uuid, at timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path = hq, public, pg_temp
AS $$
DECLARE
  surface text[];
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
    IF to_regclass('public.' || surface[1]) IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_schema = 'public' AND c.table_name = surface[1] AND c.column_name = 'user_id')
       AND EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_schema = 'public' AND c.table_name = surface[1] AND c.column_name = surface[2]) THEN
      q := q || format(
        ' UNION ALL SELECT s.user_id, s.%I FROM public.%I s WHERE s.%I >= $1 AND s.user_id IS NOT NULL',
        surface[2], surface[1], surface[2]);
    END IF;
  END LOOP;

  RETURN QUERY EXECUTE
    'SELECT a.user_id, a.at FROM (' || q || ') a(user_id, at)
       JOIN public.users u ON u.id = a.user_id
      WHERE NOT u.is_ai AND NOT u.is_seed AND NOT u.is_guest AND NOT u.is_deleted'
    USING p_since;
END;
$$;

-- ── retention cohorts ─────────────────────────────────────────────────────
-- Weekly signup cohorts (Monday-start weeks, Tbilisi) of real registered
-- users, newest last. For a user who signed up on Tbilisi day S:
--   d1  = played on day S+1
--   d7  = played on any day S+7 … S+13   (the "second week")
--   d30 = played on any day S+30 … S+59  (the "second month")
-- Each value is the share (0–1, 3 decimals) of the cohort retained. It is NULL
-- until the window has fully elapsed for every member of the cohort (i.e. for
-- the cohort's last signup day), so partial windows never look like churn.
CREATE FUNCTION hq.retention_cohorts(p_weeks integer DEFAULT 8)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = hq, public, pg_temp
AS $$
  WITH params AS (
    SELECT LEAST(GREATEST(p_weeks, 1), 26) AS weeks,
           (now() AT TIME ZONE 'Asia/Tbilisi')::date AS today
  ),
  bounds AS (
    SELECT weeks, today,
           (date_trunc('week', today::timestamp)::date - (weeks - 1) * 7) AS first_week
      FROM params
  ),
  cohort_users AS (
    SELECT u.id,
           (u.created_at AT TIME ZONE 'Asia/Tbilisi')::date AS signup_day,
           date_trunc('week', (u.created_at AT TIME ZONE 'Asia/Tbilisi'))::date AS cohort_start
      FROM public.users u, bounds b
     WHERE NOT u.is_ai AND NOT u.is_seed AND NOT u.is_guest AND NOT u.is_deleted
       AND (u.created_at AT TIME ZONE 'Asia/Tbilisi')::date >= b.first_week
  ),
  plays AS (
    SELECT DISTINCT a.user_id, (a.at AT TIME ZONE 'Asia/Tbilisi')::date AS day
      FROM bounds b,
           hq.user_activity((b.first_week::timestamp AT TIME ZONE 'Asia/Tbilisi')) a
     WHERE a.user_id IN (SELECT id FROM cohort_users)
  ),
  per_user AS (
    SELECT cu.cohort_start, cu.signup_day,
           EXISTS (SELECT 1 FROM plays p WHERE p.user_id = cu.id AND p.day = cu.signup_day + 1) AS r1,
           EXISTS (SELECT 1 FROM plays p WHERE p.user_id = cu.id AND p.day BETWEEN cu.signup_day + 7 AND cu.signup_day + 13) AS r7,
           EXISTS (SELECT 1 FROM plays p WHERE p.user_id = cu.id AND p.day BETWEEN cu.signup_day + 30 AND cu.signup_day + 59) AS r30
      FROM cohort_users cu
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
    LEFT JOIN (
      SELECT cohort_start, count(*) AS size,
             count(*) FILTER (WHERE r1) AS r1, count(*) FILTER (WHERE r7) AS r7, count(*) FILTER (WHERE r30) AS r30
        FROM per_user GROUP BY cohort_start
    ) c ON c.cohort_start = w.cohort_start;
$$;

-- ── analytics snapshot ────────────────────────────────────────────────────
-- Read-only company analytics over the last p_days Tbilisi days (incl. today):
--   series         per day: new_users, active_players (distinct registered
--                  players on any play surface), matches (multiplayer matches
--                  with at least one real human), zero-filled, oldest first
--   actives        dau (today), wau (last 7 days), mau (last 30 days)
--   modes          multiplayer matches by mode over the period, bucketed like
--                  admin-stats: grid | party_quiz | auction | ranked | friendly
--   modes_by_day   [{date, mode, matches}]
--   countries      players (active in the period) and registered, by users.country
CREATE FUNCTION hq.analytics_snapshot(p_days integer DEFAULT 30)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = hq, public, pg_temp
AS $$
  WITH params AS (
    SELECT LEAST(GREATEST(p_days, 1), 90) AS days,
           (now() AT TIME ZONE 'Asia/Tbilisi')::date AS today
  ),
  win AS (
    SELECT days, today, today - (days - 1) AS first_day,
           ((LEAST(today - (days - 1), today - 29))::timestamp AT TIME ZONE 'Asia/Tbilisi') AS since
      FROM params
  ),
  real_users AS (
    SELECT u.id, u.country, u.created_at
      FROM public.users u
     WHERE NOT u.is_ai AND NOT u.is_seed AND NOT u.is_guest AND NOT u.is_deleted
  ),
  activity AS (
    SELECT DISTINCT a.user_id, (a.at AT TIME ZONE 'Asia/Tbilisi')::date AS day
      FROM win, hq.user_activity(win.since) a
  ),
  human_matches AS (
    SELECT m.id, (m.started_at AT TIME ZONE 'Asia/Tbilisi')::date AS day,
           CASE
             WHEN m.game_variant = 'football_grid' THEN 'grid'
             WHEN m.game_variant = 'friendly_party_quiz' THEN 'party_quiz'
             WHEN m.mode = 'auction' THEN 'auction'
             WHEN m.mode = 'ranked' THEN 'ranked'
             ELSE 'friendly'
           END AS mode
      FROM public.matches m, win
     WHERE NOT m.is_dev
       AND m.started_at >= (win.first_day::timestamp AT TIME ZONE 'Asia/Tbilisi')
       AND EXISTS (SELECT 1 FROM public.match_players mp JOIN real_users ru ON ru.id = mp.user_id
                    WHERE mp.match_id = m.id)
  ),
  days AS (
    SELECT generate_series(win.first_day, win.today, interval '1 day')::date AS day FROM win
  ),
  new_by_day AS (
    SELECT (ru.created_at AT TIME ZONE 'Asia/Tbilisi')::date AS day, count(*) AS n
      FROM real_users ru, win
     WHERE ru.created_at >= (win.first_day::timestamp AT TIME ZONE 'Asia/Tbilisi')
     GROUP BY 1
  ),
  active_by_day AS (
    SELECT a.day, count(*) AS n FROM activity a GROUP BY 1
  ),
  matches_by_day AS (
    SELECT hm.day, count(*) AS n FROM human_matches hm GROUP BY 1
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'timezone', 'Asia/Tbilisi',
    'days', (SELECT days FROM win),
    'total_registered_users', (SELECT count(*) FROM real_users),
    'series', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'date', d.day::text,
               'new_users', COALESCE(nu.n, 0),
               'active_players', COALESCE(ap.n, 0),
               'matches', COALESCE(mt.n, 0)
             ) ORDER BY d.day), '[]'::jsonb)
        FROM days d
        LEFT JOIN new_by_day nu ON nu.day = d.day
        LEFT JOIN active_by_day ap ON ap.day = d.day
        LEFT JOIN matches_by_day mt ON mt.day = d.day
    ),
    'actives', (
      SELECT jsonb_build_object(
        'dau', count(DISTINCT a.user_id) FILTER (WHERE a.day = w.today),
        'wau', count(DISTINCT a.user_id) FILTER (WHERE a.day > w.today - 7),
        'mau', count(DISTINCT a.user_id) FILTER (WHERE a.day > w.today - 30)
      ) FROM activity a, win w
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
            LEFT JOIN (
              SELECT DISTINCT a.user_id FROM activity a, win w WHERE a.day >= w.first_day
            ) ap ON ap.user_id = ru.id
           GROUP BY 1
        ) c
    ), '[]'::jsonb)
  );
$$;

-- ── access ─────────────────────────────────────────────────────────────────
ALTER TABLE hq.goals    ENABLE ROW LEVEL SECURITY;
ALTER TABLE hq.standups ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION hq.user_activity(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.retention_cohorts(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.analytics_snapshot(integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON hq.goals, hq.standups TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.user_activity(timestamptz) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.retention_cohorts(integer) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.analytics_snapshot(integer) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.fire_schedule(uuid, timestamptz, timestamptz, text) TO service_role';
  END IF;
END $$;

-- ── seed: standups replace the morning schedules ──────────────────────────
-- Ops Reporter's briefing moves to 08:30 so it can read the standups.
UPDATE hq.schedules s
   SET cron = '30 8 * * *', next_run_at = NULL, updated_at = now()
  FROM hq.members m
 WHERE m.id = s.member_id AND m.slug = 'ops-reporter' AND s.name = 'Morning briefing';

-- Weekly growth/social drafting now arrives as standup proposals.
DELETE FROM hq.schedules s
 USING hq.members m
 WHERE m.id = s.member_id
   AND ((m.slug = 'growth-writer' AND s.name = 'Weekly push notifications')
     OR (m.slug = 'social-media-manager' AND s.name = 'Weekly content plan'));

-- One "Daily standup" at 08:00 Tbilisi per active HQ agent.
INSERT INTO hq.schedules (member_id, name, cron, timezone, task_title, task_body, task_kind)
SELECT m.id, 'Daily standup', '0 8 * * *', 'Asia/Tbilisi', 'Daily standup',
       'Morning standup: report yesterday / today / blockers and propose up to 3 ideas that move the goals.',
       'standup'
  FROM hq.members m
 WHERE m.kind = 'agent' AND m.runtime = 'hq' AND m.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM hq.schedules x WHERE x.member_id = m.id AND x.task_kind = 'standup');

-- Starting goals (the CEO edits them).
INSERT INTO hq.goals (horizon, title, description, metric, target, period_start, period_end, department)
VALUES
  ('north_star', 'Grow to 10,000 weekly active players',
   'Weekly active players = distinct players (registered or guest) who played anything in the last 7 Tbilisi days — the WAU on the Analytics page.',
   'active_players', 10000,
   (now() AT TIME ZONE 'Asia/Tbilisi')::date, (now() AT TIME ZONE 'Asia/Tbilisi')::date + 90, NULL),
  ('week', 'Ship HQ and start daily standups', '', NULL, NULL,
   date_trunc('week', (now() AT TIME ZONE 'Asia/Tbilisi'))::date,
   date_trunc('week', (now() AT TIME ZONE 'Asia/Tbilisi'))::date + 6, 'leadership');
