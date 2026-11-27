-- ideas_suggested as it was in 20261127190000_harness_markets_ideas.sql
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
  IF j.result ? 'saved' THEN RETURN 0; END IF;
  INSERT INTO harness.ideas (source, agent_slug, market, kind, title, detail, source_url, actions)
  SELECT 'agent', j.agent_slug, x->>'market', x->>'kind', left(btrim(x->>'title'), 200), left(btrim(coalesce(x->>'detail', '')), 2000),
         nullif(x->>'source_url', ''), CASE WHEN jsonb_typeof(x->'actions') = 'array' THEN x->'actions' ELSE '[]'::jsonb END
    FROM jsonb_array_elements(p_ideas) AS x
   WHERE x->>'market' IN ('all', 'ge', 'tr', 'ar', 'uk', 'es')
     AND x->>'kind' IN ('category', 'event', 'questions', 'other')
     AND length(btrim(coalesce(x->>'title', ''))) >= 3
     AND length(coalesce(x->>'source_url', '')) <= 1000
   LIMIT 20;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE harness.jobs SET result = coalesce(result, '{}'::jsonb) || jsonb_build_object('saved', n) WHERE id = j.id;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION harness.ideas_suggested(uuid, uuid, jsonb) FROM PUBLIC;
-- The old function knows a job saved its ideas by a mark in the job's result: write that mark for every job that
-- saved under the new one, before the link to its ideas is dropped.
UPDATE harness.jobs j
   SET result = coalesce(j.result, '{}'::jsonb) || jsonb_build_object('saved', s.n)
  FROM (SELECT job_id, count(*) AS n FROM harness.ideas WHERE job_id IS NOT NULL GROUP BY job_id) s
 WHERE j.id = s.job_id;
DROP INDEX IF EXISTS harness.harness_ideas_job;
ALTER TABLE harness.ideas DROP COLUMN IF EXISTS job_id;

NOTIFY pgrst, 'reload schema';
