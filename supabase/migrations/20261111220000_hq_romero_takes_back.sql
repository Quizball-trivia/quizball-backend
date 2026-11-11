-- Founder 2026-11-11: Romero runs everything up to staging; the founder only accepts production and decides
-- money, messages to players, payments/private data and public posts.
--   1. director_start_build: an idea he turns into a build closes as that build (it leaves the founder's list);
--      an escalated task he starts a fix for is no longer waiting for the founder.
--   2. director_decide_proposal: large ideas for read-only agents are his to approve too.
--   3. director_take_back: he can take back something he sent to the founder that is his to handle.

CREATE OR REPLACE FUNCTION hq.director_start_build(p_director uuid, p_run_task uuid, p_claim_token uuid, p_title text, p_spec text, p_kind text, p_repos text[], p_evidence text, p_source_task uuid DEFAULT NULL::uuid)
 RETURNS hq.build_jobs
 LANGUAGE plpgsql
 SET search_path TO 'hq', 'pg_temp'
AS $function$
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
  IF (SELECT count(*) FROM hq.build_jobs WHERE created_at >= v_today) >= 8 THEN
    RAISE EXCEPTION 'eight builds were started today already; start it tomorrow (or ask the founder)' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO hq.build_requests (requested_by, title, spec, kind, repos, status, director_note, decided_at)
  VALUES (d.id, btrim(p_title), p_spec, p_kind, (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(p_repos) AS x),
          'approved', 'Started by the Director after verifying the problem (evidence in HQ).', now())
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
    -- The idea is now this build: it leaves the founder's list and the open ideas.
    IF s.kind = 'proposal' AND s.status = 'proposed' THEN
      UPDATE hq.tasks
         SET status = 'done', completed_at = now(), escalated_at = NULL,
             claimed_by = NULL, claimed_at = NULL, claim_token = NULL,
             result = left('Became build #' || r.number || ', started by ' || d.name || '.', 4000),
             director_decision = 'approved', director_note = left('Building it: build #' || r.number || '.', 4000),
             decided_at = now(), updated_at = now()
       WHERE id = s.id;
    ELSIF s.escalated_at IS NOT NULL THEN
      UPDATE hq.tasks
         SET escalated_at = NULL, director_note = left(d.name || ' is fixing it: build #' || r.number || '.', 4000), updated_at = now()
       WHERE id = s.id;
    END IF;
  END IF;
  INSERT INTO hq.messages (task_id, author_id, kind, body)
  VALUES (t, d.id, 'system', left('Why: ' || v_evidence, 20000));
  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES ('director_build_started', d.id, t, left(d.name || ' started build #' || r.number || ' ' || r.title, 500),
          jsonb_build_object('request_id', r.id, 'job_id', j.id, 'source_task', p_source_task));
  RETURN j;
END;
$function$
;

CREATE OR REPLACE FUNCTION hq.director_decide_proposal(p_director uuid, p_run_task uuid, p_claim_token uuid, p_task uuid, p_expected_updated_at timestamp with time zone, p_decision text, p_note text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'hq', 'pg_temp'
AS $function$
DECLARE
  d hq.members;
  t hq.tasks;
  a hq.members;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF p_decision NOT IN ('approve', 'decline', 'escalate') THEN
    RAISE EXCEPTION 'decision must be approve, decline or escalate' USING ERRCODE = 'P0001';
  END IF;
  d := hq.director_check_run(p_director, p_run_task, p_claim_token);

  SELECT * INTO t FROM hq.tasks WHERE id = p_task FOR UPDATE;
  IF t.id IS NULL OR t.kind <> 'proposal' OR t.status <> 'proposed' THEN
    RAISE EXCEPTION 'this is not an idea waiting for a decision (status %)', COALESCE(t.status, 'missing') USING ERRCODE = 'P0001';
  END IF;
  IF t.escalated_at IS NOT NULL THEN
    RAISE EXCEPTION 'already sent to the founder; take it back first (hq_take_back) if it is yours to decide' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_updated_at IS NULL OR t.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'the idea changed since you read it; read it again before deciding' USING ERRCODE = 'P0001';
  END IF;
  IF p_decision <> 'approve' AND v_note IS NULL THEN
    RAISE EXCEPTION 'say why in the note' USING ERRCODE = 'P0001';
  END IF;

  IF p_decision = 'approve' THEN
    SELECT * INTO a FROM hq.members WHERE id = t.assignee_id;
    IF a.id IS NULL OR a.kind <> 'agent' OR a.runtime <> 'hq' OR a.status <> 'active' THEN
      RAISE EXCEPTION 'only ideas for an active HQ agent can be approved by you; escalate it' USING ERRCODE = 'P0001';
    END IF;
    IF a.role <> 'agent' THEN
      RAISE EXCEPTION 'you cannot approve your own ideas (or your advisor''s); escalate them' USING ERRCODE = 'P0001';
    END IF;
    IF a.tier <> 'read' THEN
      RAISE EXCEPTION '% can change things (code, posts, money); only the founder approves its work — escalate it', a.name USING ERRCODE = 'P0001';
    END IF;
    UPDATE hq.tasks
       SET status = 'todo', attempts = 0, completed_at = NULL,
           claimed_by = NULL, claimed_at = NULL, claim_token = NULL,
           director_decision = 'approved', director_note = v_note, decided_at = now(), updated_at = now()
     WHERE id = t.id;
  ELSIF p_decision = 'decline' THEN
    UPDATE hq.tasks
       SET status = 'cancelled', completed_at = now(),
           claimed_by = NULL, claimed_at = NULL, claim_token = NULL,
           director_decision = 'declined', director_note = v_note, decided_at = now(), updated_at = now()
     WHERE id = t.id;
    IF t.assignee_id IS NOT NULL THEN
      INSERT INTO hq.messages (task_id, author_id, recipient_id, kind, body)
      VALUES (t.id, d.id, t.assignee_id, 'comment', left('Not now: ' || v_note, 20000));
    END IF;
  ELSE
    UPDATE hq.tasks
       SET escalated_at = now(), director_decision = 'escalated', director_note = v_note,
           decided_at = now(), updated_at = now()
     WHERE id = t.id;
  END IF;

  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES (
    'director_' || CASE p_decision WHEN 'approve' THEN 'approved' WHEN 'decline' THEN 'declined' ELSE 'escalated' END,
    d.id, t.id,
    left(d.name || CASE p_decision WHEN 'approve' THEN ' approved the idea #' WHEN 'decline' THEN ' said not now to #' ELSE ' sent to the founder #' END
         || t.number || ' ' || t.title || COALESCE(' — ' || v_note, ''), 500),
    jsonb_build_object('decision', p_decision, 'run_task_id', p_run_task)
  );
  RETURN CASE p_decision WHEN 'approve' THEN 'todo' WHEN 'decline' THEN 'cancelled' ELSE 'proposed' END;
END;
$function$;

CREATE OR REPLACE FUNCTION hq.director_take_back(p_director uuid, p_run_task uuid, p_claim_token uuid, p_task uuid, p_note text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'hq', 'pg_temp'
AS $function$
DECLARE
  d hq.members;
  t hq.tasks;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  d := hq.director_check_run(p_director, p_run_task, p_claim_token);
  IF v_note IS NULL OR length(v_note) < 10 THEN
    RAISE EXCEPTION 'say why it is yours to handle' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO t FROM hq.tasks WHERE id = p_task FOR UPDATE;
  IF t.id IS NULL OR t.kind NOT IN ('task', 'proposal') OR t.status IN ('done', 'cancelled') THEN
    RAISE EXCEPTION 'only open tasks and ideas can be taken back' USING ERRCODE = 'P0001';
  END IF;
  -- Only what he himself sent up; the founder's own escalations and decisions stay with the founder.
  IF t.escalated_at IS NULL OR t.director_decision IS DISTINCT FROM 'escalated' OR t.founder_approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'this is not something you sent to the founder' USING ERRCODE = 'P0001';
  END IF;
  UPDATE hq.tasks
     SET escalated_at = NULL, director_decision = NULL, decided_at = NULL,
         director_note = left('Taken back by ' || d.name || ': ' || v_note, 4000), updated_at = now()
   WHERE id = t.id;
  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES ('director_took_back', d.id, t.id, left(d.name || ' took back #' || t.number || ' ' || t.title || ' — ' || v_note, 500),
          jsonb_build_object('run_task_id', p_run_task));
  RETURN t.status;
END;
$function$;

REVOKE ALL ON FUNCTION hq.director_take_back(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.director_take_back(uuid, uuid, uuid, uuid, text) TO service_role';
  END IF;
END $$;
