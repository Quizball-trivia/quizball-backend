-- QuizBall HQ (owner, 11 Nov): the Executive Director starts builds himself when he finds a problem and has
-- verified it, and closes tasks he checked are done or fixed.
--   1. hq.director_update_task gains 'resolve': done, with how he verified it as the result (accepted as reviewed).
--      Same fences as his other moves (never a person's, the founder's, an act agent's or his own work).
--   2. hq.director_start_build: the Director files and approves a build in one step, with the evidence of what he
--      verified. Same daily cap and one-running-build rule as approvals; the build runs in the sealed sandbox and
--      ends as a draft PR the founder merges. Only the founder can cancel it besides the Director.

CREATE OR REPLACE FUNCTION hq.director_update_task(
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
  IF p_action IS NULL OR p_action NOT IN ('reassign', 'park', 'resume', 'block', 'unblock', 'priority', 'resolve') THEN
    RAISE EXCEPTION 'unknown action % (reassign, park, resume, block, unblock, priority, resolve)', p_action USING ERRCODE = 'P0001';
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

  -- A block the system set (runs kept failing, timed out or hit the size limit) is a safety stop: a person
  -- decides whether and how it runs again, so no move may restart it (unblock, reassign, park then resume).
  -- Only a block that waits on something (the agent said so, or you set it) is yours to lift.
  IF t.status = 'blocked' AND p_action NOT IN ('priority', 'resolve') AND EXISTS (
    SELECT 1 FROM (
      SELECT r.status FROM hq.runs r WHERE r.task_id = t.id ORDER BY r.started_at DESC LIMIT 1
    ) last_run WHERE last_run.status IN ('failed', 'timeout')
  ) THEN
    RAISE EXCEPTION 'it stopped itself after failed runs (or its size limit); only the founder restarts it — escalate it' USING ERRCODE = 'P0001';
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
    v_status := 'todo';
  ELSIF p_action = 'resolve' THEN
    -- Closed as done after the Director checked it is done or fixed (the note says how he verified it).
    v_status := 'done';
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
         director_note = v_note, decided_at = now(), updated_at = now(),
         completed_at = CASE WHEN v_status = 'done' THEN now() ELSE completed_at END,
         result = CASE WHEN p_action = 'resolve' THEN left('Resolved by ' || d.name || ': ' || v_note, 20000) ELSE result END,
         review_state = CASE WHEN p_action = 'resolve' THEN 'accepted' ELSE review_state END,
         reviewed_at = CASE WHEN p_action = 'resolve' THEN now() ELSE reviewed_at END
   WHERE id = t.id;

  INSERT INTO hq.messages (task_id, author_id, kind, body)
  VALUES (t.id, d.id, 'system', left(
    CASE p_action
      WHEN 'reassign' THEN 'Reassigned to ' || n.name
      WHEN 'park' THEN 'Parked'
      WHEN 'resume' THEN 'Back on the board'
      WHEN 'block' THEN 'Blocked'
      WHEN 'unblock' THEN 'Unblocked'
      WHEN 'resolve' THEN 'Resolved (checked: done or fixed)'
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
                 WHEN 'resolve' THEN 'resolved #' || t.number
                 ELSE 'set #' || t.number || ' to priority ' || v_priority
               END || ' ' || t.title || ' — ' || v_note, 500),
          jsonb_build_object('run_task_id', p_run_task, 'action', p_action, 'from', t.status, 'to', v_status,
                             'from_assignee', t.assignee_id, 'to_assignee', v_assignee,
                             'from_priority', t.priority, 'to_priority', v_priority));
  RETURN v_status;
END;
$$;


CREATE FUNCTION hq.director_start_build(
  p_director uuid,
  p_run_task uuid,
  p_claim_token uuid,
  p_title text,
  p_spec text,
  p_kind text,
  p_repos text[],
  p_evidence text,
  p_source_task uuid DEFAULT NULL
)
RETURNS hq.build_jobs
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  d hq.members;
  b hq.members;
  r hq.build_requests;
  j hq.build_jobs;
  s hq.tasks;
  t uuid;
  v_evidence text := NULLIF(btrim(COALESCE(p_evidence, '')), '');
  v_today timestamptz := ((now() AT TIME ZONE 'Asia/Tbilisi')::date)::timestamp AT TIME ZONE 'Asia/Tbilisi';
BEGIN
  d := hq.director_check_run(p_director, p_run_task, p_claim_token);
  IF v_evidence IS NULL OR length(v_evidence) < 40 THEN
    RAISE EXCEPTION 'say what you verified and how (data, code, a reproduction): at least a few sentences' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO b FROM hq.members WHERE runtime = 'hq_code' AND kind = 'agent' AND status <> 'archived' ORDER BY created_at LIMIT 1;
  IF b.id IS NULL THEN
    RAISE EXCEPTION 'there is no Builder on the team yet; tell the founder' USING ERRCODE = 'P0001';
  END IF;
  IF p_source_task IS NOT NULL THEN
    SELECT * INTO s FROM hq.tasks WHERE id = p_source_task FOR UPDATE;
    IF s.id IS NULL OR s.kind NOT IN ('task', 'proposal') OR s.status IN ('done', 'cancelled') THEN
      RAISE EXCEPTION 'the task it fixes must be open' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hq.build_approve'));
  IF (SELECT count(*) FROM hq.build_jobs WHERE created_at >= v_today) >= 3 THEN
    RAISE EXCEPTION 'three builds were started today already; start it tomorrow (or ask the founder)' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO hq.build_requests (requested_by, title, spec, kind, repos, status, director_note, decided_at)
  VALUES (d.id, btrim(p_title), p_spec, p_kind, (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(p_repos) AS x),
          'approved', left('Started by the Director. Verified: ' || v_evidence, 4000), now())
  RETURNING * INTO r;
  INSERT INTO hq.tasks (title, body, status, priority, kind, assignee_id, created_by_id, parent_id, ref)
  VALUES (left('Build #' || r.number || ': ' || r.title, 200), left(r.spec, 30000), 'todo', 2, 'task', b.id, d.id, p_source_task,
          jsonb_build_object('build_request', r.id))
  RETURNING id INTO t;
  INSERT INTO hq.build_jobs (request_id, task_id, spec, repos) VALUES (r.id, t, r.spec, r.repos) RETURNING * INTO j;
  UPDATE hq.tasks SET ref = ref || jsonb_build_object('build_job', j.id) WHERE id = t;
  IF s.id IS NOT NULL THEN
    INSERT INTO hq.messages (task_id, author_id, kind, body)
    VALUES (s.id, d.id, 'system', left('Build #' || r.number || ' started by ' || d.name || ' to fix this. ' || v_evidence, 20000));
  END IF;
  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES ('director_build_started', d.id, t, left(d.name || ' started build #' || r.number || ' ' || r.title, 500),
          jsonb_build_object('request_id', r.id, 'job_id', j.id, 'source_task', p_source_task));
  RETURN j;
END;
$$;

REVOKE ALL ON FUNCTION hq.director_start_build(uuid, uuid, uuid, text, text, text, text[], text, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.director_start_build(uuid, uuid, uuid, text, text, text, text[], text, uuid) TO service_role';
  END IF;
END $$;
