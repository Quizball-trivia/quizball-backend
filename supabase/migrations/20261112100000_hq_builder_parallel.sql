-- Founder 2026-11-12: no daily build limit ("why do we even have that"). Builds run in parallel up to
-- hq.settings.build_slots (default 2; omarchy has 16 cores and 27 GB), each in its own sealed sandbox.
--   1. director_start_build / director_decide_build: the daily cap is gone (copied from the live definitions; only
--      the cap check is removed).
--   2. build_claim: a worker takes an active build whose lease lapsed, or else the oldest queued build when fewer than
--      build_slots builds are active.

-- The slot count in build_claim (under its advisory lock) now limits how many builds are active.
DROP INDEX IF EXISTS hq.hq_build_jobs_one_running;

ALTER TABLE hq.settings ADD COLUMN IF NOT EXISTS build_slots integer NOT NULL DEFAULT 2;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hq_settings_build_slots') THEN
    ALTER TABLE hq.settings ADD CONSTRAINT hq_settings_build_slots CHECK (build_slots BETWEEN 1 AND 6);
  END IF;
END $$;

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
    -- The idea is now this build: it leaves the founder's list and the open ideas. Only what is his to hand off
    -- (see hq.director_may_take_back); anything else keeps its own gate and just gets the message above.
    IF NOT hq.director_may_take_back(d, s) THEN
      NULL;
    ELSIF s.kind = 'proposal' AND s.status = 'proposed' THEN
      UPDATE hq.tasks
         SET status = 'done', completed_at = now(), escalated_at = NULL,
             claimed_by = NULL, claimed_at = NULL, claim_token = NULL,
             result = left('Became build #' || r.number || ', started by ' || d.name || '.', 4000),
             director_decision = 'approved', director_note = left('Building it: build #' || r.number || '.', 4000),
             review_state = 'superseded', reviewed_at = now(), decided_at = now(), updated_at = now()
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

CREATE OR REPLACE FUNCTION hq.build_claim(p_worker text, p_lease interval DEFAULT '00:15:00'::interval)
 RETURNS hq.build_jobs
 LANGUAGE plpgsql
 SET search_path TO 'hq', 'pg_temp'
AS $function$
DECLARE
  b hq.members;
  j hq.build_jobs;
  v_slots integer;
BEGIN
  SELECT * INTO b FROM hq.members WHERE runtime = 'hq_code' AND kind = 'agent' AND status = 'active' ORDER BY created_at LIMIT 1;
  IF b.id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hq.build_claim'));
  -- An active build whose worker is gone (lease lapsed) comes first.
  SELECT * INTO j FROM hq.build_jobs
   WHERE stage IN ('building', 'reviewing', 'testing', 'rating')
     AND (lease_until IS NULL OR lease_until <= now())
   ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF j.id IS NULL THEN
    SELECT COALESCE((SELECT build_slots FROM hq.settings LIMIT 1), 2) INTO v_slots;
    IF (SELECT count(*) FROM hq.build_jobs WHERE stage IN ('building', 'reviewing', 'testing', 'rating')) >= v_slots THEN
      RETURN NULL;
    END IF;
    SELECT * INTO j FROM hq.build_jobs WHERE stage = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF j.id IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;
  UPDATE hq.build_jobs
     SET stage = CASE WHEN stage = 'queued' THEN 'building' ELSE stage END,
         lease_token = gen_random_uuid(), lease_owner = p_worker,
         lease_until = now() + LEAST(GREATEST(COALESCE(p_lease, interval '15 minutes'), interval '1 minute'), interval '2 hours'),
         started_at = COALESCE(started_at, now()), updated_at = now()
   WHERE id = j.id
  RETURNING * INTO j;
  UPDATE hq.tasks SET status = 'in_progress', claimed_by = p_worker, claimed_at = now(), updated_at = now()
   WHERE id = j.task_id AND status IN ('todo', 'in_progress');
  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES ('build_claimed', b.id, j.task_id, 'Builder took build job #' || j.number, jsonb_build_object('job_id', j.id, 'worker', p_worker));
  RETURN j;
END;
$function$;
