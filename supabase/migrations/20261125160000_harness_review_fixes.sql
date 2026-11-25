-- HQ harness: fixes from the final review of 20261125120000_harness_core.sql
-- (already applied, so changes land here).
--
-- 1. harness.start_run: an agent run is recorded only while its job is still
--    running under the caller's lease. A job cancelled (superseded) between
--    claim and start can no longer start a model call, so cancelling it frees
--    a concurrency slot that nothing else is using.
-- 2. classic_health: a released question archived by an editor no longer
--    counts as inventory on its way to the pool.

CREATE FUNCTION harness.start_run(
  p_job uuid, p_token uuid, p_agent text, p_account text, p_provider text, p_model text, p_prompt_version text, p_worker text
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  PERFORM 1 FROM harness.jobs WHERE id = p_job AND status = 'running' AND lease_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO harness.runs (job_id, agent_slug, account_id, provider, model, prompt_version, worker)
  VALUES (p_job, p_agent, p_account, p_provider, p_model, p_prompt_version, p_worker)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION harness.classic_health(p_cap integer DEFAULT 100)
RETURNS TABLE (
  category_id uuid, slug text, views_30d bigint, pool bigint, in_pipeline bigint, needed bigint, shortage bigint,
  pool_easy bigint, pool_medium bigint, pool_hard bigint, pipe_easy bigint, pipe_medium bigint, pipe_hard bigint
)
LANGUAGE sql
STABLE
SET search_path = public, harness, pg_temp
AS $$
  WITH views AS (
    SELECT mq.category_id, count(*) AS v
      FROM public.match_questions mq
      JOIN public.matches m ON m.id = mq.match_id
      JOIN public.questions q ON q.id = mq.question_id
     WHERE m.mode = 'ranked' AND NOT coalesce(m.is_dev, false)
       AND q.type = 'mcq_single'
       AND mq.shown_at IS NOT NULL
       AND mq.shown_at > now() - interval '30 days'
     GROUP BY 1
  ), pool AS (
    SELECT q.category_id, count(*) AS n,
           count(*) FILTER (WHERE q.difficulty = 'easy') AS e,
           count(*) FILTER (WHERE q.difficulty = 'medium') AS m,
           count(*) FILTER (WHERE q.difficulty = 'hard') AS h
      FROM public.questions q
     WHERE q.status = 'published' AND q.visibility = 'public'
       AND q.ranked_eligible AND q.type = 'mcq_single'
     GROUP BY 1
  ), pipe AS (
    SELECT i.category_id, count(*) AS n,
           count(*) FILTER (WHERE i.difficulty = 'easy') AS e,
           count(*) FILTER (WHERE i.difficulty = 'medium') AS m,
           count(*) FILTER (WHERE i.difficulty = 'hard') AS h
      FROM harness.items i
      LEFT JOIN public.questions pq ON pq.id = i.question_id
     WHERE i.mode = 'classic'
       AND i.stage IN ('draft', 'validated', 'verified', 'localized', 'approved')
       -- not released yet, or released as a draft still waiting; a published
       -- one is in the pool, an archived one is on its way nowhere
       AND (pq.id IS NULL OR pq.status = 'draft')
       -- released, then deleted by an editor: not on its way any more
       AND NOT (i.released_at IS NOT NULL AND i.question_id IS NULL)
     GROUP BY 1
  )
  SELECT c.id, c.slug, v.v, coalesce(p.n, 0), coalesce(x.n, 0),
         ceil(v.v::numeric / greatest(p_cap, 1))::bigint,
         greatest(ceil(v.v::numeric / greatest(p_cap, 1))::bigint - coalesce(p.n, 0) - coalesce(x.n, 0), 0),
         coalesce(p.e, 0), coalesce(p.m, 0), coalesce(p.h, 0), coalesce(x.e, 0), coalesce(x.m, 0), coalesce(x.h, 0)
    FROM views v
    JOIN public.categories c ON c.id = v.category_id AND c.is_active
    LEFT JOIN pool p ON p.category_id = v.category_id
    LEFT JOIN pipe x ON x.category_id = v.category_id
   ORDER BY 7 DESC, 3 DESC;
$$;


REVOKE ALL ON FUNCTION harness.start_run(uuid, uuid, text, text, text, text, text, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.start_run(uuid, uuid, text, text, text, text, text, text) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.classic_health(integer) TO service_role';
  END IF;
END $$;
