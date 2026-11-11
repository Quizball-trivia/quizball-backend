-- Romero (the Director) acts on his own plan, and Sentinel watches production.
--
-- 1. A plan item for Romero himself or for an active read-only HQ agent can start at once (p_start), and Romero can
--    start his own plan items still waiting for the founder. Work by agents that change things (tier 'act': code,
--    posts, money) still waits for the founder; the database refuses it.
-- 2. hq.health_snapshot(): numbers the Sentinel watcher compares every few minutes (connections, stuck queries,
--    locks, rollbacks, matches and sign-ups against the same window a week ago). Aggregates only, no player data.
-- 3. Sentinel, the monitoring agent (paused; switched on after release).
-- 4. The Director is called Romero, and keeps the founder in the loop: the 13:00 and 18:00 reviews become progress
--    updates posted to the founder's chat (with a new one at 15:00).

-- ── 1. Romero's plan ────────────────────────────────────────────────────────
DROP FUNCTION hq.director_plan_item(uuid, uuid, uuid, text, text, text, uuid);

-- Whether Romero may start work for this assignee himself.
CREATE FUNCTION hq.director_may_start(d hq.members, a hq.members)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = hq, pg_temp
AS $$
  SELECT a.id = d.id
      OR (a.kind = 'agent' AND a.runtime = 'hq' AND a.status = 'active' AND a.role = 'agent' AND a.tier = 'read');
$$;

CREATE FUNCTION hq.director_plan_item(
  p_director uuid,
  p_run_task uuid,
  p_claim_token uuid,
  p_title text,
  p_plan text,
  p_why text,
  p_assignee uuid,
  p_start boolean DEFAULT false
)
RETURNS TABLE (id uuid, number bigint, started boolean)
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  d hq.members;
  a hq.members;
  v_today integer;
  v_new hq.tasks;
BEGIN
  d := hq.director_check_run(p_director, p_run_task, p_claim_token);
  IF length(btrim(COALESCE(p_title, ''))) < 3 OR length(btrim(COALESCE(p_plan, ''))) = 0 THEN
    RAISE EXCEPTION 'give each plan item a title and what will be done' USING ERRCODE = 'P0001';
  END IF;
  IF p_assignee IS NOT NULL THEN
    SELECT * INTO a FROM hq.members WHERE members.id = p_assignee AND kind = 'agent' AND runtime = 'hq' AND status <> 'archived';
    IF a.id IS NULL THEN
      RAISE EXCEPTION 'plan items go to an HQ agent (or yourself)' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    a := d;
  END IF;
  IF COALESCE(p_start, false) AND NOT hq.director_may_start(d, a) THEN
    RAISE EXCEPTION '% cannot start on your say alone (it is off, or it changes code, posts or money); leave it for the founder', a.name
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hq.director_plan:' || p_director::text));
  SELECT count(*) INTO v_today FROM hq.tasks t
   WHERE t.created_by_id = p_director AND t.kind = 'proposal' AND t.proposal ->> 'plan_day' IS NOT NULL
     AND t.created_at >= ((now() AT TIME ZONE 'Asia/Tbilisi')::date)::timestamp AT TIME ZONE 'Asia/Tbilisi';
  IF v_today >= 8 THEN
    RAISE EXCEPTION 'today''s plan already has 8 items; keep it focused' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO hq.tasks (title, body, status, kind, priority, assignee_id, created_by_id, depth, proposal,
                        escalated_at, director_decision, director_note, decided_at)
  VALUES (left(btrim(p_title), 200),
          '**Plan:** ' || p_plan || COALESCE(E'\n\n**Why:** ' || NULLIF(btrim(COALESCE(p_why, '')), ''), ''),
          CASE WHEN p_start THEN 'todo' ELSE 'proposed' END, 'proposal', 1, a.id, p_director, 1,
          jsonb_build_object('why', COALESCE(p_why, ''), 'plan', p_plan, 'expectedImpact', '', 'effort', 'm',
                             'plan_day', ((now() AT TIME ZONE 'Asia/Tbilisi')::date)::text),
          CASE WHEN p_start THEN NULL ELSE now() END,
          CASE WHEN p_start THEN 'approved' ELSE 'escalated' END,
          CASE WHEN p_start THEN 'Today''s plan — started by ' || d.name || '.' ELSE 'Today''s plan — starts when you approve it.' END,
          now())
  RETURNING * INTO v_new;
  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES (CASE WHEN p_start THEN 'director_approved' ELSE 'director_escalated' END, d.id, v_new.id,
          left(d.name || ' planned #' || v_new.number || ' ' || v_new.title
               || CASE WHEN p_start THEN ' (started)' ELSE ' (waiting for you)' END, 500),
          jsonb_build_object('plan_day', v_new.proposal ->> 'plan_day', 'started', COALESCE(p_start, false)));
  RETURN QUERY SELECT v_new.id, v_new.number, COALESCE(p_start, false);
END;
$$;

-- Romero starts one of his own plan items that is still waiting for the founder.
CREATE FUNCTION hq.director_start_plan_item(
  p_director uuid,
  p_run_task uuid,
  p_claim_token uuid,
  p_task uuid,
  p_expected_updated_at timestamptz,
  p_note text
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  d hq.members;
  t hq.tasks;
  a hq.members;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  d := hq.director_check_run(p_director, p_run_task, p_claim_token);
  IF v_note IS NULL OR length(v_note) < 20 THEN
    RAISE EXCEPTION 'say why it is worth doing now and how you checked (at least a sentence)' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO t FROM hq.tasks WHERE id = p_task FOR UPDATE;
  IF t.id IS NULL OR t.created_by_id IS DISTINCT FROM p_director OR t.kind <> 'proposal' OR t.status <> 'proposed'
     OR t.proposal ->> 'plan_day' IS NULL OR t.director_decision IS DISTINCT FROM 'escalated' THEN
    RAISE EXCEPTION 'only your own plan items still waiting for the founder can be started this way' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_updated_at IS NULL OR t.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'the item changed since you read it; read it again first' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO a FROM hq.members WHERE id = t.assignee_id;
  IF a.id IS NULL OR NOT hq.director_may_start(d, a) THEN
    RAISE EXCEPTION '% cannot start on your say alone (it is off, or it changes code, posts or money); it stays with the founder',
      COALESCE(a.name, 'its assignee') USING ERRCODE = 'P0001';
  END IF;
  UPDATE hq.tasks
     SET status = 'todo', attempts = 0, completed_at = NULL, escalated_at = NULL,
         claimed_by = NULL, claimed_at = NULL, claim_token = NULL,
         director_decision = 'approved', director_note = left('Started by ' || d.name || ': ' || v_note, 2000),
         decided_at = now(), updated_at = now()
   WHERE id = t.id;
  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES ('director_approved', d.id, t.id, left(d.name || ' started his plan item #' || t.number || ' ' || t.title || ' — ' || v_note, 500),
          jsonb_build_object('run_task_id', p_run_task, 'plan_day', t.proposal ->> 'plan_day'));
  RETURN t.number;
END;
$$;

-- ── 2. health snapshot ──────────────────────────────────────────────────────
CREATE FUNCTION hq.health_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '15s'
SET lock_timeout = '2s'
AS $$
DECLARE
  v jsonb;
BEGIN
  SELECT jsonb_build_object(
    'at', now(),
    'connections', (SELECT jsonb_object_agg(COALESCE(state, 'none'), n) FROM (
        SELECT state, count(*) AS n FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY state) s),
    'max_connections', current_setting('max_connections')::int,
    'idle_in_txn_over_60s', (SELECT count(*) FROM pg_stat_activity
        WHERE state LIKE 'idle in transaction%' AND now() - state_change > interval '60 seconds'),
    'longest_active_query_s', (SELECT COALESCE(round(max(extract(epoch FROM now() - query_start))), 0) FROM pg_stat_activity
        WHERE state = 'active' AND backend_type = 'client backend' AND pid <> pg_backend_pid()),
    'waiting_on_locks', (SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'),
    'db', (SELECT jsonb_build_object('commits', xact_commit, 'rollbacks', xact_rollback, 'deadlocks', deadlocks,
                                     'temp_bytes', temp_bytes, 'conflicts', conflicts)
             FROM pg_stat_database WHERE datname = current_database()),
    'matches_30m', (SELECT count(*) FROM public.matches WHERE started_at > now() - interval '30 minutes'),
    'matches_30m_week_ago', (SELECT count(*) FROM public.matches
        WHERE started_at BETWEEN now() - interval '7 days 30 minutes' AND now() - interval '7 days'),
    'matches_abandoned_60m', (SELECT count(*) FROM public.matches
        WHERE started_at > now() - interval '60 minutes' AND status = 'abandoned'),
    'matches_60m', (SELECT count(*) FROM public.matches WHERE started_at > now() - interval '60 minutes'),
    'matches_stuck_active_2h', (SELECT count(*) FROM public.matches
        WHERE status = 'active' AND started_at BETWEEN now() - interval '2 days' AND now() - interval '2 hours'),
    -- every game: [last hour, same hour a week ago] (dailies over 3 hours: they are smaller)
    'games', (SELECT jsonb_object_agg(g.game, g.n) FROM (
        SELECT 'classic:' || COALESCE(mode, '?') AS game,
               jsonb_build_array(count(*) FILTER (WHERE started_at > now() - interval '60 minutes'),
                                 count(*) FILTER (WHERE started_at <= now() - interval '7 days')) AS n
          FROM public.matches
         WHERE started_at > now() - interval '60 minutes'
            OR started_at BETWEEN now() - interval '7 days 60 minutes' AND now() - interval '7 days'
         GROUP BY mode
        UNION ALL
        SELECT 'grid', jsonb_build_array(count(*) FILTER (WHERE created_at > now() - interval '60 minutes'),
                                         count(*) FILTER (WHERE created_at <= now() - interval '7 days'))
          FROM public.football_grid_matches
         WHERE created_at > now() - interval '60 minutes'
            OR created_at BETWEEN now() - interval '7 days 60 minutes' AND now() - interval '7 days'
        UNION ALL
        SELECT 'rooms', jsonb_build_array(count(*) FILTER (WHERE started_at > now() - interval '60 minutes'),
                                          count(*) FILTER (WHERE started_at <= now() - interval '7 days'))
          FROM public.room_matches
         WHERE started_at > now() - interval '60 minutes'
            OR started_at BETWEEN now() - interval '7 days 60 minutes' AND now() - interval '7 days'
        UNION ALL
        SELECT 'duels', jsonb_build_array(count(*) FILTER (WHERE started_at > now() - interval '60 minutes'),
                                          count(*) FILTER (WHERE started_at <= now() - interval '7 days'))
          FROM public.duel_matches
         WHERE started_at > now() - interval '60 minutes'
            OR started_at BETWEEN now() - interval '7 days 60 minutes' AND now() - interval '7 days'
        UNION ALL
        SELECT 'dailies_3h', jsonb_build_array(count(*) FILTER (WHERE completed_at > now() - interval '3 hours'),
                                               count(*) FILTER (WHERE completed_at <= now() - interval '7 days'))
          FROM public.daily_challenge_completions
         WHERE completed_at > now() - interval '3 hours'
            OR completed_at BETWEEN now() - interval '7 days 3 hours' AND now() - interval '7 days'
        UNION ALL
        SELECT 'guest_dailies_3h', jsonb_build_array(count(*) FILTER (WHERE created_at > now() - interval '3 hours'),
                                                     count(*) FILTER (WHERE created_at <= now() - interval '7 days'))
          FROM public.guest_daily_completions
         WHERE created_at > now() - interval '3 hours'
            OR created_at BETWEEN now() - interval '7 days 3 hours' AND now() - interval '7 days'
      ) g),
    'signups_60m', (SELECT count(*) FROM public.users WHERE created_at > now() - interval '60 minutes'),
    'signups_60m_week_ago', (SELECT count(*) FROM public.users
        WHERE created_at BETWEEN now() - interval '7 days 60 minutes' AND now() - interval '7 days')
  ) INTO v;
  RETURN v;
END;
$$;

-- ── 3. Sentinel ─────────────────────────────────────────────────────────────
INSERT INTO hq.members (slug, kind, name, title, avatar, color, department, description, instructions,
                        tools, autonomy, runtime, status, max_turns, role, tier, model, effort)
VALUES (
  'sentinel', 'agent', 'Sentinel', 'Production monitor', '🛰️', 'slate', 'engineering',
  'Watches production (API, database, game numbers) and checks every deploy; investigates anything odd and tells Romero.',
  $i$You watch QuizBall production. A watcher checks the API, the database and the game numbers every few minutes and detects every production deploy of backend, web and CMS; when something looks off, or after a deploy, you get a task with the readings.
1) Read the readings in the task. Take fresh ones: hq_health_snapshot (database and game numbers against the same time a week ago), hq_http_timing (quizball.io, www, api; /health and /health/db), hq_deploys (what changed and when).
2) Investigate: compare with the baseline, check twice, look for the cause (the deploy and its commits, the code at file:line with hq_code_search / hq_code_read, the slow queries in hq_perf_db_report, load).
3) Be 100% sure before you call something a problem; say how you checked. A false alarm is reported as such, in two lines.
4) hq_finish with: what you saw (numbers, before and after), whether it is real, how bad (players affected), the likely cause and what to do now (roll back, fix, watch). After a deploy, say plainly whether everything works.
You never change anything.$i$,
  ARRAY['perf', 'metrics', 'code', 'monitor'], 'autonomous', 'hq', 'paused', 40, 'agent', 'read', 'claude-sonnet-5-5', 'high'
)
ON CONFLICT (slug) DO NOTHING;

-- ── 4. Romero and his progress updates ──────────────────────────────────────
UPDATE hq.members SET name = 'Romero', updated_at = now()
 WHERE role = 'director' AND kind = 'agent' AND name = 'Executive Director';

UPDATE hq.schedules s
   SET task_kind = 'brief', task_title = 'Progress update for the founder', name = 'Progress update ' || to_char(
         (regexp_match(s.cron, '^0 (\d+) '))[1]::int, 'FM00') || ':00',
       task_body = 'Review ideas and finished work, then post a progress update to the founder.', updated_at = now()
  FROM hq.members m
 WHERE m.id = s.member_id AND m.role = 'director' AND s.name IN ('Midday review', 'Evening review');

INSERT INTO hq.schedules (member_id, name, cron, timezone, task_title, task_body, task_kind, enabled)
SELECT m.id, 'Progress update 15:00', '0 15 * * *', 'Asia/Tbilisi', 'Progress update for the founder',
       'Review ideas and finished work, then post a progress update to the founder.', 'brief', true
  FROM hq.members m
 WHERE m.role = 'director' AND m.kind = 'agent' AND m.status <> 'archived'
   AND NOT EXISTS (SELECT 1 FROM hq.schedules x WHERE x.member_id = m.id AND x.cron = '0 15 * * *');

-- ── grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION hq.director_may_start(hq.members, hq.members) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.director_plan_item(uuid, uuid, uuid, text, text, text, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.director_start_plan_item(uuid, uuid, uuid, uuid, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.health_snapshot() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.director_may_start(hq.members, hq.members) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.director_plan_item(uuid, uuid, uuid, text, text, text, uuid, boolean) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.director_start_plan_item(uuid, uuid, uuid, uuid, timestamptz, text) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.health_snapshot() TO service_role';
  END IF;
END $$;
