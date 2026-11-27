-- A scouting round saves its ideas once, even when its job is run again (HQ, straight to prod).
-- The first version marked the save in the job's result, which finish_job overwrites when a job is requeued:
-- a second run could then save the same ideas again. The mark is now on the ideas themselves: which job
-- suggested them.

ALTER TABLE harness.ideas ADD COLUMN job_id uuid REFERENCES harness.jobs(id) ON DELETE SET NULL;
CREATE INDEX harness_ideas_job ON harness.ideas (job_id) WHERE job_id IS NOT NULL;

CREATE OR REPLACE FUNCTION harness.ideas_suggested(p_job uuid, p_token uuid, p_ideas jsonb)
RETURNS integer
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  j harness.jobs;
  n integer;
BEGIN
  SELECT * INTO j FROM harness.jobs WHERE id = p_job AND status = 'running' AND lease_token = p_token FOR UPDATE;
  IF NOT FOUND OR j.kind <> 'idea_scout' OR jsonb_typeof(p_ideas) <> 'array' THEN RETURN 0; END IF;
  -- This job already saved its ideas on an earlier run.
  IF EXISTS (SELECT 1 FROM harness.ideas WHERE job_id = j.id) THEN RETURN 0; END IF;
  INSERT INTO harness.ideas (source, agent_slug, job_id, market, kind, title, detail, source_url, actions)
  SELECT 'agent', j.agent_slug, j.id, x->>'market', x->>'kind', left(btrim(x->>'title'), 200), left(btrim(coalesce(x->>'detail', '')), 2000),
         nullif(x->>'source_url', ''), CASE WHEN jsonb_typeof(x->'actions') = 'array' THEN x->'actions' ELSE '[]'::jsonb END
    FROM jsonb_array_elements(p_ideas) AS x
   WHERE x->>'market' IN ('all', 'ge', 'tr', 'ar', 'uk', 'es')
     AND x->>'kind' IN ('category', 'event', 'questions', 'other')
     AND length(btrim(coalesce(x->>'title', ''))) >= 3
     AND length(coalesce(x->>'source_url', '')) <= 1000
   LIMIT 20;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION harness.ideas_suggested(uuid, uuid, jsonb) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.ideas_suggested(uuid, uuid, jsonb) TO service_role';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
