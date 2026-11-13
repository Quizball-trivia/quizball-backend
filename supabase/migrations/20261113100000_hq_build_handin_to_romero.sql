-- Founder 2026-11-13: "why do so many things need me". Every finished or failed build landed in the founder's
-- Needs you. Now a build's hand-in goes to Romero (failed builds are in his list to re-run, re-spec or drop); only a
-- published build (its PR open) comes to the founder, as the production decision.

CREATE OR REPLACE FUNCTION hq.build_finish(p_job uuid, p_lease_token uuid, p_outcome text, p_result text, p_evidence jsonb DEFAULT NULL::jsonb)
 RETURNS hq.build_jobs
 LANGUAGE plpgsql
 SET search_path TO 'hq', 'pg_temp'
AS $function$
DECLARE
  j hq.build_jobs;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('ready_to_publish', 'failed') THEN
    RAISE EXCEPTION 'outcome must be ready_to_publish or failed' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO j FROM hq.build_jobs WHERE id = p_job FOR UPDATE;
  IF j.id IS NULL OR j.lease_token IS DISTINCT FROM p_lease_token OR j.lease_until IS NULL OR j.lease_until <= now()
     OR j.stage NOT IN ('building', 'reviewing', 'testing', 'rating') THEN
    RAISE EXCEPTION 'this build is no longer yours (cancelled or taken over); stop' USING ERRCODE = 'P0001';
  END IF;
  UPDATE hq.build_jobs
     SET stage = p_outcome, lease_token = NULL, lease_owner = NULL, lease_until = NULL, finished_at = now(),
         evidence = evidence || COALESCE(p_evidence, '{}'::jsonb), note = left(p_result, 4000), updated_at = now()
   WHERE id = j.id
  RETURNING * INTO j;
  -- The hand-in goes to Romero, not the founder: a failed build is his to re-run, re-spec or drop, and a ready one
  -- reaches the founder only once its PR is open (build_published), as the production decision.
  UPDATE hq.tasks
     SET status = 'done',
         result = left(CASE WHEN p_outcome = 'failed' THEN 'Build failed: ' ELSE '' END || p_result, 20000),
         completed_at = now(),
         claimed_by = NULL, claimed_at = NULL, claim_token = NULL, updated_at = now()
   WHERE id = j.task_id AND status NOT IN ('cancelled');
  INSERT INTO hq.events (type, task_id, message, data)
  VALUES ('build_' || p_outcome, j.task_id, left('Build job #' || j.number || CASE WHEN p_outcome = 'failed' THEN ' failed: ' ELSE ' is ready: ' END || p_result, 500),
          jsonb_build_object('job_id', j.id));
  RETURN j;
END;
$function$;

CREATE OR REPLACE FUNCTION hq.build_checkpoint(p_job uuid, p_lease_token uuid, p_stage text, p_checkpoint jsonb DEFAULT NULL::jsonb, p_evidence jsonb DEFAULT NULL::jsonb, p_note text DEFAULT NULL::text, p_runs integer DEFAULT 0)
 RETURNS hq.build_jobs
 LANGUAGE plpgsql
 SET search_path TO 'hq', 'pg_temp'
AS $function$
DECLARE
  j hq.build_jobs;
  v_order text[] := ARRAY['building', 'reviewing', 'testing', 'rating'];
BEGIN
  SELECT * INTO j FROM hq.build_jobs WHERE id = p_job FOR UPDATE;
  IF j.id IS NULL OR j.lease_token IS DISTINCT FROM p_lease_token OR j.lease_until IS NULL OR j.lease_until <= now()
     OR j.stage NOT IN ('building', 'reviewing', 'testing', 'rating') THEN
    RAISE EXCEPTION 'this build is no longer yours (cancelled or taken over); stop' USING ERRCODE = 'P0001';
  END IF;
  IF p_stage IS NULL OR NOT p_stage = ANY (v_order) THEN
    RAISE EXCEPTION 'stage must be building, reviewing, testing or rating' USING ERRCODE = 'P0001';
  END IF;
  -- Back to building is allowed (a review or a play-test found something to fix); otherwise forward only.
  IF array_position(v_order, p_stage) < array_position(v_order, j.stage) AND p_stage <> 'building' THEN
    RAISE EXCEPTION 'a build moves forward (or back to building to fix something)' USING ERRCODE = 'P0001';
  END IF;
  -- Over its run limit: the build stops for good (returned, not raised, so the stop is kept). The caller sees 'failed'.
  IF j.runs_used + GREATEST(p_runs, 0) > j.run_limit THEN
    UPDATE hq.build_jobs
       SET stage = 'failed', lease_token = NULL, lease_owner = NULL, lease_until = NULL, finished_at = now(),
           runs_used = j.run_limit, note = 'Stopped at its run limit (' || j.run_limit || ' runs)', updated_at = now()
     WHERE id = j.id
    RETURNING * INTO j;
    UPDATE hq.tasks
       SET status = 'done', result = 'Build failed: stopped at its run limit (' || j.run_limit || ' runs). The Director decides what next.',
           completed_at = now(), claimed_by = NULL, claimed_at = NULL, claim_token = NULL, updated_at = now()
     WHERE id = j.task_id AND status NOT IN ('done', 'cancelled');
    RETURN j;
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
$function$;
