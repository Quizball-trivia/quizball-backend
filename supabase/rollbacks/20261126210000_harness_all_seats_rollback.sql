-- Agents go back to the seats they had before (20261126121500_harness_all_seats_for_agents).
UPDATE harness.agents SET fallback_accounts = '{}' WHERE provider = 'codex';
UPDATE harness.agents SET fallback_accounts = ARRAY['claude-premium-4', 'claude-premium-5'] WHERE slug IN ('content-planner', 'hq-assistant');
UPDATE harness.agents SET fallback_accounts = ARRAY['claude-premium-5', 'claude-premium-4', 'claude-premium-1'] WHERE slug = 'localizer';
UPDATE harness.agents SET fallback_accounts = ARRAY['claude-premium-1', 'claude-premium-5', 'claude-premium-4'] WHERE slug = 'question-maker';
ALTER TABLE harness.agents DROP CONSTRAINT IF EXISTS harness_agents_alt_complete, DROP CONSTRAINT IF EXISTS harness_agents_alt_differs,
  DROP COLUMN IF EXISTS alt_provider, DROP COLUMN IF EXISTS alt_model, DROP COLUMN IF EXISTS alt_effort;
-- start_run as it was (no seat limit).
CREATE OR REPLACE FUNCTION harness.start_run(p_job uuid, p_token uuid, p_agent text, p_account text, p_provider text, p_model text, p_prompt_version text, p_worker text)
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
ALTER TABLE harness.accounts DROP COLUMN IF EXISTS max_parallel;
UPDATE harness.settings SET daily_run_limit = 1500, max_concurrent_runs = 3, updated_at = now() WHERE id;
NOTIFY pgrst, 'reload schema';
