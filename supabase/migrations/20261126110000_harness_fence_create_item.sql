-- Review fixes (PR #1054 / question-agents #60):
-- 1. create_item is fenced by the make job's lease, like transition: a worker
--    whose lease was recovered can no longer add items to the brief.
-- 2. One verdict per item version and kind, so a retried checker can record
--    its verdict again safely (the worker upserts on this key).

CREATE UNIQUE INDEX IF NOT EXISTS harness_verdicts_one_per_version
  ON harness.verdicts (item_id, item_version, kind);

DROP FUNCTION IF EXISTS harness.create_item(jsonb, text, jsonb, jsonb);

CREATE FUNCTION harness.create_item(
  p_item jsonb,
  p_to_stage text,
  p_patch jsonb DEFAULT '{}'::jsonb,
  p_jobs jsonb DEFAULT '[]'::jsonb,
  p_current_job uuid DEFAULT NULL,
  p_current_token uuid DEFAULT NULL
)
RETURNS SETOF harness.items
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_current_job IS NOT NULL THEN
    PERFORM 1 FROM harness.jobs
     WHERE id = p_current_job
       AND brief_id IS NOT DISTINCT FROM (p_item ->> 'brief_id')::uuid
       AND status = 'running'
       AND lease_token = p_current_token
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'job % is no longer running; its result is stale', p_current_job USING ERRCODE = '40001';
    END IF;
  END IF;
  INSERT INTO harness.items (mode, contract_version, brief_id, category_id, difficulty, payload, sources)
  VALUES (p_item ->> 'mode', (p_item ->> 'contract_version')::integer, (p_item ->> 'brief_id')::uuid,
          (p_item ->> 'category_id')::uuid, p_item ->> 'difficulty', p_item -> 'payload', coalesce(p_item -> 'sources', '[]'::jsonb))
  RETURNING id INTO v_id;
  RETURN QUERY SELECT * FROM harness.transition(v_id, 'draft', 0, p_to_stage, p_patch, p_jobs);
END;
$$;

REVOKE ALL ON FUNCTION harness.create_item(jsonb, text, jsonb, jsonb, uuid, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.create_item(jsonb, text, jsonb, jsonb, uuid, uuid) TO service_role';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
