DROP INDEX IF EXISTS harness.harness_verdicts_one_per_version;
DROP FUNCTION IF EXISTS harness.create_item(jsonb, text, jsonb, jsonb, uuid, uuid);
CREATE FUNCTION harness.create_item(p_item jsonb, p_to_stage text, p_patch jsonb DEFAULT '{}'::jsonb, p_jobs jsonb DEFAULT '[]'::jsonb)
RETURNS SETOF harness.items LANGUAGE plpgsql SET search_path = harness, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO harness.items (mode, contract_version, brief_id, category_id, difficulty, payload, sources)
  VALUES (p_item ->> 'mode', (p_item ->> 'contract_version')::integer, (p_item ->> 'brief_id')::uuid,
          (p_item ->> 'category_id')::uuid, p_item ->> 'difficulty', p_item -> 'payload', coalesce(p_item -> 'sources', '[]'::jsonb))
  RETURNING id INTO v_id;
  RETURN QUERY SELECT * FROM harness.transition(v_id, 'draft', 0, p_to_stage, p_patch, p_jobs);
END $$;
REVOKE ALL ON FUNCTION harness.create_item(jsonb, text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION harness.create_item(jsonb, text, jsonb, jsonb) TO service_role;
