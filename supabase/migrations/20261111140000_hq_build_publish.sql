-- QuizBall HQ: a handed-in build becomes draft PRs. The publisher (its own OS user on the office machine, the only
-- holder of the GitHub App key) opens one draft PR per repo to staging from the Builder's exported patch, then
-- records the links here. Only a job still 'ready_to_publish' can be published (a cancelled one never is); the
-- founder reviews and merges on GitHub.

CREATE FUNCTION hq.build_published(p_job uuid, p_prs jsonb, p_note text DEFAULT NULL)
RETURNS hq.build_jobs
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  j hq.build_jobs;
  v_links text;
BEGIN
  IF p_prs IS NULL OR jsonb_typeof(p_prs) <> 'array' OR jsonb_array_length(p_prs) = 0 THEN
    RAISE EXCEPTION 'p_prs must be a non-empty array of {repo, url}' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO j FROM hq.build_jobs WHERE id = p_job FOR UPDATE;
  IF j.id IS NULL OR j.stage <> 'ready_to_publish' THEN
    RAISE EXCEPTION 'build job is not waiting to be published (stage %)', COALESCE(j.stage, 'missing') USING ERRCODE = 'P0001';
  END IF;
  SELECT string_agg('- ' || (e->>'repo') || ': ' || (e->>'url'), E'\n') INTO v_links FROM jsonb_array_elements(p_prs) e;
  UPDATE hq.build_jobs
     SET stage = 'published', evidence = evidence || jsonb_build_object('prs', p_prs), updated_at = now()
   WHERE id = j.id
  RETURNING * INTO j;
  -- The Builder's task stays in the founder's Needs you, now with the PRs to review and merge.
  UPDATE hq.tasks SET escalated_at = now(), updated_at = now() WHERE id = j.task_id;
  INSERT INTO hq.messages (task_id, kind, body)
  VALUES (j.task_id, 'system', left('Draft PRs to staging, ready for your review and merge:' || E'\n' || v_links
          || CASE WHEN p_note IS NOT NULL THEN E'\n\n' || p_note ELSE '' END, 20000));
  INSERT INTO hq.events (type, task_id, message, data)
  VALUES ('build_published', j.task_id, left('Build job #' || j.number || ' opened draft PRs: ' || v_links, 500), jsonb_build_object('job_id', j.id, 'prs', p_prs));
  RETURN j;
END;
$$;

-- The publisher could not open the PRs (a patch that does not apply, a refused path): the build goes back to the
-- founder with the reason; nothing is pushed.
CREATE FUNCTION hq.build_publish_failed(p_job uuid, p_reason text)
RETURNS hq.build_jobs
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  j hq.build_jobs;
BEGIN
  SELECT * INTO j FROM hq.build_jobs WHERE id = p_job FOR UPDATE;
  IF j.id IS NULL OR j.stage <> 'ready_to_publish' THEN
    RAISE EXCEPTION 'build job is not waiting to be published (stage %)', COALESCE(j.stage, 'missing') USING ERRCODE = 'P0001';
  END IF;
  UPDATE hq.build_jobs
     SET stage = 'failed', note = left('Publishing failed: ' || COALESCE(p_reason, ''), 4000), updated_at = now()
   WHERE id = j.id
  RETURNING * INTO j;
  UPDATE hq.tasks SET escalated_at = now(), updated_at = now() WHERE id = j.task_id;
  INSERT INTO hq.messages (task_id, kind, body) VALUES (j.task_id, 'system', left('Publishing failed: ' || COALESCE(p_reason, ''), 20000));
  INSERT INTO hq.events (type, task_id, message, data)
  VALUES ('build_publish_failed', j.task_id, left('Build job #' || j.number || ': publishing failed: ' || COALESCE(p_reason, ''), 500), jsonb_build_object('job_id', j.id));
  RETURN j;
END;
$$;

REVOKE ALL ON FUNCTION hq.build_published(uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.build_publish_failed(uuid, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.build_published(uuid, jsonb, text) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.build_publish_failed(uuid, text) TO service_role';
  END IF;
END $$;
