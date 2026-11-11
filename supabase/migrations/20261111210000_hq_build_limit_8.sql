-- Founder 2026-11-11: Romero may start or approve up to 8 builds a day (was 3). The Builder still runs one at a time.

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
    SELECT * INTO s FROM hq.tasks WHERE id = p_source_task FOR SHARE;
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

CREATE OR REPLACE FUNCTION hq.director_decide_build(p_director uuid, p_run_task uuid, p_claim_token uuid, p_request uuid, p_expected_updated_at timestamp with time zone, p_decision text, p_note text, p_final_spec text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'hq', 'pg_temp'
AS $function$
DECLARE
  d hq.members;
  r hq.build_requests;
  h hq.members;
  b hq.members;
  j hq.build_jobs;
  t uuid;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_spec text;
  v_today timestamptz := ((now() AT TIME ZONE 'Asia/Tbilisi')::date)::timestamp AT TIME ZONE 'Asia/Tbilisi';
BEGIN
  d := hq.director_check_run(p_director, p_run_task, p_claim_token);
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'changes_requested', 'decline') THEN
    RAISE EXCEPTION 'decide approve, changes_requested or decline' USING ERRCODE = 'P0001';
  END IF;
  IF v_note IS NULL THEN
    RAISE EXCEPTION 'say why (the requester and the founder read it)' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO r FROM hq.build_requests WHERE id = p_request FOR UPDATE;
  IF r.id IS NULL OR r.status <> 'submitted' THEN
    RAISE EXCEPTION 'this request is not waiting for a decision (status %)', COALESCE(r.status, 'missing') USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_updated_at IS NULL OR r.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'the request changed since you read it; read it again' USING ERRCODE = 'P0001';
  END IF;

  IF p_decision = 'approve' THEN
    SELECT * INTO h FROM hq.members WHERE id = r.requested_by FOR SHARE;
    IF h.id IS NULL OR h.status <> 'active' OR NOT (h.is_founder OR h.can_request_builds) THEN
      RAISE EXCEPTION 'the requester may no longer ask for builds; tell the founder' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO b FROM hq.members WHERE runtime = 'hq_code' AND kind = 'agent' AND status <> 'archived' ORDER BY created_at LIMIT 1;
    IF b.id IS NULL THEN
      RAISE EXCEPTION 'there is no Builder on the team yet; tell the founder' USING ERRCODE = 'P0001';
    END IF;
    -- Serialises approvals, so the daily cap holds.
    PERFORM pg_advisory_xact_lock(hashtext('hq.build_approve'));
    IF (SELECT count(*) FROM hq.build_jobs WHERE created_at >= v_today) >= 8 THEN
      RAISE EXCEPTION 'eight builds were approved today already; approve it tomorrow (or the founder can)' USING ERRCODE = 'P0001';
    END IF;
    v_spec := COALESCE(NULLIF(btrim(COALESCE(p_final_spec, '')), ''), r.spec);
    INSERT INTO hq.tasks (title, body, status, priority, kind, assignee_id, created_by_id, ref, founder_approved_at)
    VALUES (left('Build #' || r.number || ': ' || r.title, 200), left(v_spec, 30000), 'todo', 2, 'task', b.id, d.id,
            jsonb_build_object('build_request', r.id), NULL)
    RETURNING id INTO t;
    INSERT INTO hq.build_jobs (request_id, task_id, spec, repos) VALUES (r.id, t, v_spec, r.repos) RETURNING * INTO j;
    UPDATE hq.tasks SET ref = ref || jsonb_build_object('build_job', j.id) WHERE id = t;
    UPDATE hq.build_requests
       SET status = 'approved', director_spec = CASE WHEN v_spec <> r.spec THEN v_spec END,
           director_note = v_note, decided_at = now(), updated_at = now()
     WHERE id = r.id;
  ELSE
    UPDATE hq.build_requests
       SET status = CASE WHEN p_decision = 'decline' THEN 'declined' ELSE 'changes_requested' END,
           director_note = v_note, decided_at = now(), updated_at = now()
     WHERE id = r.id;
  END IF;

  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES ('director_build_' || p_decision, d.id, t,
          left(d.name || CASE p_decision WHEN 'approve' THEN ' started build #' ELSE ' answered build request #' END
               || r.number || ' ' || r.title || ' — ' || v_note, 500),
          jsonb_build_object('request_id', r.id, 'job_id', j.id, 'decision', p_decision, 'spec_edited', v_spec IS NOT NULL AND v_spec <> r.spec));
  RETURN CASE p_decision WHEN 'approve' THEN 'approved' WHEN 'decline' THEN 'declined' ELSE 'changes_requested' END;
END;
$function$
;

