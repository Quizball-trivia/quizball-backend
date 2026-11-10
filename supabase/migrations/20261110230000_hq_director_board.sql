-- QuizBall HQ: the Executive Director runs the board himself.
--   1. hq.director_update_task: reassign work to another agent, park it,
--      bring it back, block or unblock it, change its priority. Same fences
--      as his other decisions (live run claim, the version he read, nothing
--      waiting for the founder, never a person's own task, never his own).
--   2. hq.wau_history: the North Star (weekly active players, registered +
--      guest) for every Tbilisi day, so progress can be compared over time.

CREATE FUNCTION hq.director_update_task(
  p_director uuid,
  p_run_task uuid,
  p_claim_token uuid,
  p_task uuid,
  p_expected_updated_at timestamptz,
  p_action text,
  p_note text,
  p_assignee uuid DEFAULT NULL,
  p_priority smallint DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  d hq.members;
  t hq.tasks;
  a hq.members;
  n hq.members;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_status text;
  v_assignee uuid;
  v_priority smallint;
BEGIN
  d := hq.director_check_run(p_director, p_run_task, p_claim_token);
  IF p_action NOT IN ('reassign', 'park', 'resume', 'block', 'unblock', 'priority') THEN
    RAISE EXCEPTION 'unknown action % (reassign, park, resume, block, unblock, priority)', p_action USING ERRCODE = 'P0001';
  END IF;
  IF v_note IS NULL THEN
    RAISE EXCEPTION 'say why (the assignee and the founder read it)' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO t FROM hq.tasks WHERE id = p_task FOR UPDATE;
  -- An approved idea is ordinary work (status todo onwards); a pending one is decided with hq_decide_proposal.
  IF t.id IS NULL OR t.kind NOT IN ('task', 'proposal')
     OR t.status NOT IN ('backlog', 'todo', 'in_progress', 'blocked') THEN
    RAISE EXCEPTION 'only open tasks can be changed here (status %); decide ideas with hq_decide_proposal',
      COALESCE(t.status, 'missing') USING ERRCODE = 'P0001';
  END IF;
  IF t.id = p_run_task THEN
    RAISE EXCEPTION 'you cannot change the task you are running' USING ERRCODE = 'P0001';
  END IF;
  IF t.escalated_at IS NOT NULL THEN
    RAISE EXCEPTION 'this is waiting for the founder; only the founder decides it now' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_updated_at IS NULL OR t.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'the task changed since you read it; read it again' USING ERRCODE = 'P0001';
  END IF;
  IF t.assignee_id IS NOT NULL THEN
    SELECT * INTO a FROM hq.members WHERE id = t.assignee_id;
    IF a.kind = 'human' THEN
      RAISE EXCEPTION 'that is %''s task; people decide their own work — escalate it', a.name USING ERRCODE = 'P0001';
    END IF;
    IF a.kind = 'agent' AND a.tier = 'act' THEN
      RAISE EXCEPTION '% changes things; only the founder moves its work — escalate it', a.name USING ERRCODE = 'P0001';
    END IF;
    IF a.role = 'director' THEN
      RAISE EXCEPTION 'that is your own work; finish it with a note instead' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  v_status := t.status;
  v_assignee := t.assignee_id;
  v_priority := t.priority;

  IF p_action = 'reassign' THEN
    SELECT * INTO n FROM hq.members WHERE id = p_assignee;
    IF n.id IS NULL OR n.kind <> 'agent' OR n.role <> 'agent' OR n.status = 'archived' THEN
      RAISE EXCEPTION 'reassign to one of your agents (not a person, not the advisor); escalate work for people' USING ERRCODE = 'P0001';
    END IF;
    IF n.runtime <> 'hq' THEN
      RAISE EXCEPTION '% does not take board tasks; pick an HQ agent', n.name USING ERRCODE = 'P0001';
    END IF;
    IF n.tier = 'act' THEN
      RAISE EXCEPTION '% changes things; only the founder gives it work — escalate it', n.name USING ERRCODE = 'P0001';
    END IF;
    IF n.id = t.assignee_id THEN
      RAISE EXCEPTION 'it is already assigned to %', n.name USING ERRCODE = 'P0001';
    END IF;
    v_assignee := n.id;
    v_status := CASE WHEN t.status = 'backlog' THEN 'backlog' ELSE 'todo' END;
  ELSIF p_action = 'park' THEN
    IF t.status = 'backlog' THEN
      RAISE EXCEPTION 'it is already parked' USING ERRCODE = 'P0001';
    END IF;
    v_status := 'backlog';
  ELSIF p_action = 'resume' THEN
    IF t.status <> 'backlog' THEN
      RAISE EXCEPTION 'only parked tasks can be resumed (status %)', t.status USING ERRCODE = 'P0001';
    END IF;
    v_status := 'todo';
  ELSIF p_action = 'block' THEN
    IF t.status = 'blocked' THEN
      RAISE EXCEPTION 'it is already blocked' USING ERRCODE = 'P0001';
    END IF;
    v_status := 'blocked';
  ELSIF p_action = 'unblock' THEN
    IF t.status <> 'blocked' THEN
      RAISE EXCEPTION 'only blocked tasks can be unblocked (status %)', t.status USING ERRCODE = 'P0001';
    END IF;
    -- A block the system set (runs kept failing, timed out or hit the size limit) is a safety stop: a person
    -- decides whether it runs again. Only a block that is waiting on something (the agent said so, or you set
    -- it) can be lifted here.
    IF EXISTS (
      SELECT 1 FROM (
        SELECT r.status FROM hq.runs r WHERE r.task_id = t.id ORDER BY r.started_at DESC LIMIT 1
      ) last_run WHERE last_run.status IN ('failed', 'timeout')
    ) THEN
      RAISE EXCEPTION 'it stopped itself after failed runs (or its size limit); only the founder restarts it — escalate it' USING ERRCODE = 'P0001';
    END IF;
    v_status := 'todo';
  ELSIF p_action = 'priority' THEN
    -- Urgent (0) runs even when the plan is nearly used up; that stays the founder's call.
    IF p_priority IS NULL OR p_priority NOT BETWEEN 1 AND 3 THEN
      RAISE EXCEPTION 'priority must be 1 (high), 2 (normal) or 3 (low); ask the founder for urgent' USING ERRCODE = 'P0001';
    END IF;
    IF p_priority = t.priority THEN
      RAISE EXCEPTION 'it already has priority %', p_priority USING ERRCODE = 'P0001';
    END IF;
    v_priority := p_priority;
  END IF;

  -- Leaving in_progress clears the claim, which fences a run working on it: the
  -- worker stops it at its next claim check and its result is not applied.
  UPDATE hq.tasks
     SET status = v_status,
         assignee_id = v_assignee,
         priority = v_priority,
         attempts = CASE WHEN v_assignee IS DISTINCT FROM t.assignee_id OR (p_action = 'unblock')
                         THEN 0 ELSE attempts END,
         claimed_by = CASE WHEN v_status = 'in_progress' THEN claimed_by END,
         claimed_at = CASE WHEN v_status = 'in_progress' THEN claimed_at END,
         claim_token = CASE WHEN v_status = 'in_progress' THEN claim_token END,
         director_note = v_note, decided_at = now(), updated_at = now()
   WHERE id = t.id;

  INSERT INTO hq.messages (task_id, author_id, kind, body)
  VALUES (t.id, d.id, 'system', left(
    CASE p_action
      WHEN 'reassign' THEN 'Reassigned to ' || n.name
      WHEN 'park' THEN 'Parked'
      WHEN 'resume' THEN 'Back on the board'
      WHEN 'block' THEN 'Blocked'
      WHEN 'unblock' THEN 'Unblocked'
      ELSE 'Priority ' || t.priority || ' → ' || v_priority
    END || ' by ' || d.name || ': ' || v_note, 20000));
  IF p_action = 'reassign' THEN
    INSERT INTO hq.messages (task_id, author_id, recipient_id, kind, body)
    VALUES (t.id, d.id, n.id, 'handoff', left('New for you: #' || t.number || ' ' || t.title || ' — ' || v_note, 20000));
  END IF;
  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES ('director_updated', d.id, t.id,
          left(d.name || ' ' || CASE p_action
                 WHEN 'reassign' THEN 'gave #' || t.number || ' to ' || n.name
                 WHEN 'park' THEN 'parked #' || t.number
                 WHEN 'resume' THEN 'put #' || t.number || ' back on the board'
                 WHEN 'block' THEN 'blocked #' || t.number
                 WHEN 'unblock' THEN 'unblocked #' || t.number
                 ELSE 'set #' || t.number || ' to priority ' || v_priority
               END || ' ' || t.title || ' — ' || v_note, 500),
          jsonb_build_object('run_task_id', p_run_task, 'action', p_action, 'from', t.status, 'to', v_status,
                             'from_assignee', t.assignee_id, 'to_assignee', v_assignee,
                             'from_priority', t.priority, 'to_priority', v_priority));
  RETURN v_status;
END;
$$;

-- Weekly active players (any game, registered + guest; the North Star) and the
-- registered-only figure, per Tbilisi day: each day counts the distinct players
-- of that day and the 6 before it.
CREATE FUNCTION hq.wau_history(p_days integer DEFAULT 90)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = hq, public, pg_temp
AS $$
DECLARE
  v_days integer := LEAST(GREATEST(p_days, 1), 180);
  v_today date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
  v_first date := v_today - (LEAST(GREATEST(p_days, 1), 180) - 1);
BEGIN
  PERFORM hq.ensure_activity_days(v_first - 6);
  PERFORM hq.assert_activity_covered(v_first - 6);
  RETURN (
    WITH activity AS (
      SELECT ad.day, ad.ident, ad.user_id
        FROM hq.activity_days ad
        LEFT JOIN public.users u
          ON u.id = ad.user_id AND NOT u.is_ai AND NOT u.is_seed AND NOT u.is_guest AND NOT u.is_deleted
       WHERE ad.day >= v_first - 6
         AND (ad.user_id IS NULL OR u.id IS NOT NULL)
    ),
    spread AS (
      SELECT DISTINCT (a.day + o) AS day, a.ident, a.user_id
        FROM activity a, generate_series(0, 6) AS o
       WHERE a.day + o BETWEEN v_first AND v_today
    )
    SELECT jsonb_build_object(
      'timezone', 'Asia/Tbilisi',
      'days', v_days,
      'definition', 'wau_all = distinct players (registered + guest) who played any game in the 7 Tbilisi days ending that day (the North Star). wau_registered = the same, registered accounts only. Today is partial.',
      'series', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('date', s.day::text, 'wau_all', s.wau_all, 'wau_registered', s.wau_registered)
                         ORDER BY s.day)
          FROM (
            SELECT g.day::date AS day,
                   count(DISTINCT sp.ident) AS wau_all,
                   count(DISTINCT sp.user_id) AS wau_registered
              FROM generate_series(v_first, v_today, interval '1 day') g(day)
              LEFT JOIN spread sp ON sp.day = g.day::date
             GROUP BY 1
          ) s
      ), '[]'::jsonb)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION hq.director_update_task(uuid, uuid, uuid, uuid, timestamptz, text, text, uuid, smallint) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.wau_history(integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.director_update_task(uuid, uuid, uuid, uuid, timestamptz, text, text, uuid, smallint) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.wau_history(integer) TO service_role';
  END IF;
END $$;
