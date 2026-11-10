-- QuizBall HQ: builds. The founder (or a teammate allowed to, e.g. Alfred on his own login) submits a build request
-- with a spec; the Executive Director reviews it and either approves it (optionally with an edited spec and a note on
-- what changed), asks for changes or declines. An approved request becomes one build job for the Builder, an 'act'
-- agent on its own runtime ('hq_code', a sealed sandbox on the office machine). The founder's click is not needed to
-- start a build (owner decision 2026-11-10); merging and production stay the founder's.
--
--   * Only a request a person submitted can be approved by the Director (agent ideas and player feedback cannot start
--     a build); the requester must still be allowed when it is approved. One job per request.
--   * At most one build runs at a time (others wait queued) and at most 3 are approved per Tbilisi day.
--   * The Builder holds a job by a lease (token + expiry). Every write names the token; cancelling clears it, so a
--     run that was cancelled can no longer move the job, and the worker stops at its next heartbeat.

-- ── 1. members ───────────────────────────────────────────────────────────
ALTER TABLE hq.members DROP CONSTRAINT members_runtime_check;
ALTER TABLE hq.members ADD CONSTRAINT members_runtime_check
  CHECK (runtime IN ('hq', 'question_agents', 'bug_triage', 'quiz_pages', 'hq_code', 'none'));
ALTER TABLE hq.members ADD COLUMN can_request_builds boolean NOT NULL DEFAULT false;
ALTER TABLE hq.members ADD CONSTRAINT hq_members_build_requester_is_human CHECK (NOT can_request_builds OR kind = 'human');

-- ── 2. requests and jobs ─────────────────────────────────────────────────
CREATE TABLE hq.build_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  requested_by  uuid NOT NULL REFERENCES hq.members(id),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  spec          text NOT NULL CHECK (length(spec) BETWEEN 1 AND 30000),
  kind          text NOT NULL CHECK (kind IN ('game_mode', 'feature', 'bug_fix', 'other')),
  repos         text[] NOT NULL CHECK (cardinality(repos) BETWEEN 1 AND 3 AND repos <@ ARRAY['backend', 'web', 'cms']),
  status        text NOT NULL DEFAULT 'submitted'
                CHECK (status IN ('submitted', 'changes_requested', 'declined', 'approved', 'cancelled')),
  review_task_id uuid REFERENCES hq.tasks(id) ON DELETE SET NULL,
  director_spec text CHECK (director_spec IS NULL OR length(director_spec) BETWEEN 1 AND 30000),
  director_note text,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hq_build_requests_status_idx ON hq.build_requests (status, created_at);

CREATE TABLE hq.build_jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number       bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  request_id   uuid NOT NULL UNIQUE REFERENCES hq.build_requests(id),
  task_id      uuid REFERENCES hq.tasks(id) ON DELETE SET NULL,
  spec         text NOT NULL,
  repos        text[] NOT NULL,
  stage        text NOT NULL DEFAULT 'queued' CHECK (stage IN (
                 'queued', 'building', 'reviewing', 'testing', 'rating',
                 'ready_to_publish', 'published', 'done', 'failed', 'cancelled')),
  lease_token  uuid,
  lease_owner  text,
  lease_until  timestamptz,
  runs_used    integer NOT NULL DEFAULT 0,
  run_limit    integer NOT NULL DEFAULT 40 CHECK (run_limit BETWEEN 1 AND 200),
  checkpoint   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint) = 'object'),
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- One build at a time: only one job may be past 'queued' and not yet handed in.
CREATE UNIQUE INDEX hq_build_jobs_one_running ON hq.build_jobs ((true))
  WHERE stage IN ('building', 'reviewing', 'testing', 'rating');
CREATE INDEX hq_build_jobs_queue_idx ON hq.build_jobs (created_at) WHERE stage = 'queued';

ALTER TABLE hq.build_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE hq.build_jobs ENABLE ROW LEVEL SECURITY;

-- ── 3. submit (backend, for a person) ────────────────────────────────────
CREATE FUNCTION hq.submit_build_request(p_human uuid, p_title text, p_spec text, p_kind text, p_repos text[])
RETURNS hq.build_requests
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  h hq.members;
  d hq.members;
  r hq.build_requests;
  t uuid;
  v_today timestamptz := ((now() AT TIME ZONE 'Asia/Tbilisi')::date)::timestamp AT TIME ZONE 'Asia/Tbilisi';
BEGIN
  SELECT * INTO h FROM hq.members WHERE id = p_human FOR SHARE;
  IF h.id IS NULL OR h.kind <> 'human' OR h.status <> 'active' OR NOT (h.is_founder OR h.can_request_builds) THEN
    RAISE EXCEPTION 'only the founder (or someone the founder allowed) can ask for a build' USING ERRCODE = 'P0001';
  END IF;
  -- One request at a time per person is serialised, so the daily cap holds under concurrent calls.
  PERFORM pg_advisory_xact_lock(hashtext('hq.build_request:' || p_human::text));
  IF (SELECT count(*) FROM hq.build_requests WHERE requested_by = p_human AND created_at >= v_today) >= 10 THEN
    RAISE EXCEPTION 'that is 10 build requests today; the Director has enough to review' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO d FROM hq.members WHERE role = 'director' AND status = 'active' ORDER BY created_at LIMIT 1;
  INSERT INTO hq.build_requests (requested_by, title, spec, kind, repos)
  VALUES (p_human, btrim(p_title), p_spec, p_kind, (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(p_repos) AS x))
  RETURNING * INTO r;
  -- The Director reviews it as a task of his own (read-only work: he decides with hq_decide_build).
  IF d.id IS NOT NULL THEN
    INSERT INTO hq.tasks (title, body, status, priority, kind, assignee_id, created_by_id, ref)
    VALUES (left('Review build request #' || r.number || ': ' || r.title, 200),
            'Build request #' || r.number || ' from ' || h.name || '. Read it with hq_build_requests and decide it with hq_decide_build.',
            'todo', 1, 'task', d.id, h.id, jsonb_build_object('build_request', r.id))
    RETURNING id INTO t;
    UPDATE hq.build_requests SET review_task_id = t WHERE id = r.id RETURNING * INTO r;
  END IF;
  INSERT INTO hq.events (type, member_id, message, data)
  VALUES ('build_requested', h.id, left(h.name || ' asked for a build: #' || r.number || ' ' || r.title, 500),
          jsonb_build_object('request_id', r.id, 'kind', r.kind, 'repos', r.repos));
  RETURN r;
END;
$$;

-- ── 4. the Director decides ──────────────────────────────────────────────
CREATE FUNCTION hq.director_decide_build(
  p_director uuid,
  p_run_task uuid,
  p_claim_token uuid,
  p_request uuid,
  p_expected_updated_at timestamptz,
  p_decision text,
  p_note text,
  p_final_spec text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
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
    IF (SELECT count(*) FROM hq.build_jobs WHERE created_at >= v_today) >= 3 THEN
      RAISE EXCEPTION 'three builds were approved today already; approve it tomorrow (or the founder can)' USING ERRCODE = 'P0001';
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
$$;

-- ── 5. the Builder's lease ───────────────────────────────────────────────
-- Takes the running job back if its lease lapsed, else the oldest queued job when nothing runs. NULL = nothing to do.
CREATE FUNCTION hq.build_claim(p_worker text, p_lease interval DEFAULT interval '15 minutes')
RETURNS hq.build_jobs
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  b hq.members;
  j hq.build_jobs;
BEGIN
  SELECT * INTO b FROM hq.members WHERE runtime = 'hq_code' AND kind = 'agent' AND status = 'active' ORDER BY created_at LIMIT 1;
  IF b.id IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hq.build_claim'));
  SELECT * INTO j FROM hq.build_jobs
   WHERE stage IN ('building', 'reviewing', 'testing', 'rating') FOR UPDATE;
  IF j.id IS NOT NULL THEN
    IF j.lease_until IS NOT NULL AND j.lease_until > now() THEN
      RETURN NULL;
    END IF;
  ELSE
    SELECT * INTO j FROM hq.build_jobs WHERE stage = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF j.id IS NULL THEN
      RETURN NULL;
    END IF;
  END IF;
  UPDATE hq.build_jobs
     SET stage = CASE WHEN stage = 'queued' THEN 'building' ELSE stage END,
         lease_token = gen_random_uuid(), lease_owner = p_worker, lease_until = now() + p_lease,
         started_at = COALESCE(started_at, now()), updated_at = now()
   WHERE id = j.id
  RETURNING * INTO j;
  UPDATE hq.tasks SET status = 'in_progress', claimed_by = p_worker, claimed_at = now(), updated_at = now()
   WHERE id = j.task_id AND status IN ('todo', 'in_progress');
  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES ('build_claimed', b.id, j.task_id, 'Builder took build job #' || j.number, jsonb_build_object('job_id', j.id, 'worker', p_worker));
  RETURN j;
END;
$$;

-- The job as it stands for a lease holder (NULL when the lease was lost or the job cancelled); extends the lease.
CREATE FUNCTION hq.build_heartbeat(p_job uuid, p_lease_token uuid, p_lease interval DEFAULT interval '15 minutes')
RETURNS hq.build_jobs
LANGUAGE sql
SET search_path = hq, pg_temp
AS $$
  UPDATE hq.build_jobs SET lease_until = now() + p_lease, updated_at = now()
   WHERE id = p_job AND lease_token = p_lease_token AND stage IN ('building', 'reviewing', 'testing', 'rating')
  RETURNING *;
$$;

-- Records progress. Stages only move forward through the build; a run counts against the job's run limit.
CREATE FUNCTION hq.build_checkpoint(
  p_job uuid, p_lease_token uuid, p_stage text, p_checkpoint jsonb DEFAULT NULL, p_evidence jsonb DEFAULT NULL,
  p_note text DEFAULT NULL, p_runs integer DEFAULT 0
)
RETURNS hq.build_jobs
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  j hq.build_jobs;
  v_order text[] := ARRAY['building', 'reviewing', 'testing', 'rating'];
BEGIN
  SELECT * INTO j FROM hq.build_jobs WHERE id = p_job FOR UPDATE;
  IF j.id IS NULL OR j.lease_token IS DISTINCT FROM p_lease_token OR j.stage NOT IN ('building', 'reviewing', 'testing', 'rating') THEN
    RAISE EXCEPTION 'this build is no longer yours (cancelled or taken over); stop' USING ERRCODE = 'P0001';
  END IF;
  IF p_stage IS NULL OR NOT p_stage = ANY (v_order) THEN
    RAISE EXCEPTION 'stage must be building, reviewing, testing or rating' USING ERRCODE = 'P0001';
  END IF;
  -- Back to building is allowed (a review or a play-test found something to fix); otherwise forward only.
  IF array_position(v_order, p_stage) < array_position(v_order, j.stage) AND p_stage <> 'building' THEN
    RAISE EXCEPTION 'a build moves forward (or back to building to fix something)' USING ERRCODE = 'P0001';
  END IF;
  IF j.runs_used + GREATEST(p_runs, 0) > j.run_limit THEN
    UPDATE hq.build_jobs
       SET stage = 'failed', lease_token = NULL, lease_owner = NULL, lease_until = NULL, finished_at = now(),
           note = 'Stopped at its run limit (' || j.run_limit || ' runs)', updated_at = now()
     WHERE id = j.id;
    RAISE EXCEPTION 'this build used all its % runs and was stopped; the Director decides what next', j.run_limit USING ERRCODE = 'P0001';
  END IF;
  UPDATE hq.build_jobs
     SET stage = p_stage,
         checkpoint = COALESCE(p_checkpoint, checkpoint),
         evidence = evidence || COALESCE(p_evidence, '{}'::jsonb),
         note = COALESCE(left(p_note, 4000), note),
         runs_used = runs_used + GREATEST(p_runs, 0),
         updated_at = now()
   WHERE id = j.id
  RETURNING * INTO j;
  RETURN j;
END;
$$;

-- Hands the build in: ready to publish (a draft PR comes next) or failed. The Builder's task goes to the Director's
-- review as finished work, with the outcome as its result.
CREATE FUNCTION hq.build_finish(p_job uuid, p_lease_token uuid, p_outcome text, p_result text, p_evidence jsonb DEFAULT NULL)
RETURNS hq.build_jobs
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  j hq.build_jobs;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('ready_to_publish', 'failed') THEN
    RAISE EXCEPTION 'outcome must be ready_to_publish or failed' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO j FROM hq.build_jobs WHERE id = p_job FOR UPDATE;
  IF j.id IS NULL OR j.lease_token IS DISTINCT FROM p_lease_token OR j.stage NOT IN ('building', 'reviewing', 'testing', 'rating') THEN
    RAISE EXCEPTION 'this build is no longer yours (cancelled or taken over); stop' USING ERRCODE = 'P0001';
  END IF;
  UPDATE hq.build_jobs
     SET stage = p_outcome, lease_token = NULL, lease_owner = NULL, lease_until = NULL, finished_at = now(),
         evidence = evidence || COALESCE(p_evidence, '{}'::jsonb), note = left(p_result, 4000), updated_at = now()
   WHERE id = j.id
  RETURNING * INTO j;
  UPDATE hq.tasks
     SET status = CASE WHEN p_outcome = 'failed' THEN 'blocked' ELSE 'done' END,
         result = left(p_result, 20000), completed_at = now(),
         claimed_by = NULL, claimed_at = NULL, claim_token = NULL, updated_at = now()
   WHERE id = j.task_id;
  INSERT INTO hq.events (type, task_id, message, data)
  VALUES ('build_' || p_outcome, j.task_id, left('Build job #' || j.number || CASE WHEN p_outcome = 'failed' THEN ' failed: ' ELSE ' is ready: ' END || p_result, 500),
          jsonb_build_object('job_id', j.id));
  RETURN j;
END;
$$;

-- Stops a build at any stage: the founder (through the backend) or the Director (with his live run). Clearing the
-- lease fences the Builder: its next write is refused and its heartbeat tells it to stop.
CREATE FUNCTION hq.cancel_build(p_actor uuid, p_job uuid, p_note text, p_run_task uuid DEFAULT NULL, p_claim_token uuid DEFAULT NULL)
RETURNS hq.build_jobs
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  a hq.members;
  j hq.build_jobs;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  SELECT * INTO a FROM hq.members WHERE id = p_actor;
  IF a.role = 'director' THEN
    PERFORM hq.director_check_run(p_actor, p_run_task, p_claim_token);
  ELSIF a.id IS NULL OR a.kind <> 'human' OR NOT a.is_founder THEN
    RAISE EXCEPTION 'only the founder or the Director can stop a build' USING ERRCODE = 'P0001';
  END IF;
  IF v_note IS NULL THEN
    RAISE EXCEPTION 'say why' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO j FROM hq.build_jobs WHERE id = p_job FOR UPDATE;
  IF j.id IS NULL OR j.stage IN ('done', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'this build is already over (stage %)', COALESCE(j.stage, 'missing') USING ERRCODE = 'P0001';
  END IF;
  UPDATE hq.build_jobs
     SET stage = 'cancelled', lease_token = NULL, lease_owner = NULL, lease_until = NULL, finished_at = now(),
         note = left('Cancelled by ' || a.name || ': ' || v_note, 4000), updated_at = now()
   WHERE id = j.id
  RETURNING * INTO j;
  UPDATE hq.tasks
     SET status = 'cancelled', completed_at = now(), claimed_by = NULL, claimed_at = NULL, claim_token = NULL, updated_at = now()
   WHERE id = j.task_id AND status NOT IN ('done', 'cancelled');
  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES ('build_cancelled', a.id, j.task_id, left(a.name || ' stopped build job #' || j.number || ' — ' || v_note, 500), jsonb_build_object('job_id', j.id));
  RETURN j;
END;
$$;

-- The run is over: the lease goes back at once (the next cycle continues without waiting it out).
CREATE FUNCTION hq.build_release(p_job uuid, p_lease_token uuid)
RETURNS boolean
LANGUAGE sql
SET search_path = hq, pg_temp
AS $$
  WITH r AS (
    UPDATE hq.build_jobs SET lease_until = now(), updated_at = now()
     WHERE id = p_job AND lease_token = p_lease_token RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM r);
$$;

-- ── 6. the Builder member (paused until its sandbox is live) ─────────────
INSERT INTO hq.members (slug, kind, name, title, avatar, color, description, instructions, runtime, status, tier, role, department, tools, model, effort)
VALUES (
  'builder', 'agent', 'Builder', 'Builds features, game modes and fixes', '🛠️', 'amber',
  'Builds what the Director approved, in a sealed sandbox: code, tests, reviews by GPT, play-tests, then hands it in for a draft PR.',
  'Build exactly the approved spec. Work only in your sandbox. Read the repos'' own instructions (CLAUDE.md files, the brand rules for UI) first. Keep changes small and match the code around them. Write tests for what you change. Never put real quiz questions or answers in code (the repos are public): use invented fixtures. Ask GPT for a review of each meaningful chunk and fix what holds up. Record progress with checkpoints. Hand in with what you built, how it was tested and what is left.',
  'hq_code', 'paused', 'act', 'agent', 'engineering', '{}', 'claude-opus-5-5', 'xhigh'
)
ON CONFLICT (slug) DO NOTHING;

REVOKE ALL ON hq.build_requests, hq.build_jobs FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.submit_build_request(uuid, text, text, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.director_decide_build(uuid, uuid, uuid, uuid, timestamptz, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.build_claim(text, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.build_heartbeat(uuid, uuid, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.build_checkpoint(uuid, uuid, text, jsonb, jsonb, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.build_finish(uuid, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.cancel_build(uuid, uuid, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.build_release(uuid, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    -- The functions run as the caller (service_role): it writes these tables and their identity sequences.
    EXECUTE 'GRANT ALL ON hq.build_requests, hq.build_jobs TO service_role';
    EXECUTE 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA hq TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.build_release(uuid, uuid) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.submit_build_request(uuid, text, text, text, text[]) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.director_decide_build(uuid, uuid, uuid, uuid, timestamptz, text, text, text) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.build_claim(text, interval) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.build_heartbeat(uuid, uuid, interval) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.build_checkpoint(uuid, uuid, text, jsonb, jsonb, text, integer) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.build_finish(uuid, uuid, text, text, jsonb) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.cancel_build(uuid, uuid, text, uuid, uuid) TO service_role';
  END IF;
END $$;
