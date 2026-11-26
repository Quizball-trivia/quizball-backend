-- Use every subscription (HQ, straight to prod). Owner's decision 2026-11-26:
-- no artificial daily cap, agents run until the subscriptions themselves are
-- used up, and work spreads over all seats.
--   accounts.max_parallel   how many runs one seat takes at once; more work
--                           overflows to the agent's next seat.
--   agents.alt_*            a second provider + model an agent may run on when
--                           its own provider's seats are busy or at their limit.
--                           The checkers (Codex first) get a Claude model that
--                           is never the model that wrote what they check; the
--                           worker enforces that per run.

ALTER TABLE harness.accounts
  ADD COLUMN max_parallel integer NOT NULL DEFAULT 2 CHECK (max_parallel BETWEEN 1 AND 20);
UPDATE harness.accounts SET max_parallel = 3 WHERE id IN ('claude-ultra', 'codex-1');

ALTER TABLE harness.agents
  ADD COLUMN alt_provider text CHECK (alt_provider IN ('claude', 'codex')),
  ADD COLUMN alt_model    text,
  ADD COLUMN alt_effort   text,
  ADD CONSTRAINT harness_agents_alt_complete CHECK ((alt_provider IS NULL) = (alt_model IS NULL)),
  ADD CONSTRAINT harness_agents_alt_differs CHECK (alt_provider IS NULL OR alt_provider <> provider);

-- Checkers: Codex first (a different AI family from the writers), then the
-- Claude seats. Facts and quality check English written by Opus: Sonnet. Translations are written by
-- Sonnet: Opus checks those.
UPDATE harness.agents
   SET alt_provider = 'claude', alt_model = 'claude-sonnet-5-5',
       fallback_accounts = ARRAY['claude-premium-1', 'claude-premium-4', 'claude-premium-5', 'claude-premium-2', 'claude-premium-3', 'claude-ultra']
 WHERE slug = 'fact-checker';
-- The Show Checker stays on Codex only: the bank's Georgian may have been written by either Claude model, so no
-- Claude model is independent of it. Its jobs are few and go first in the queue.
UPDATE harness.agents
   SET alt_provider = 'claude', alt_model = 'claude-sonnet-5-5',
       fallback_accounts = ARRAY['claude-premium-4', 'claude-premium-5', 'claude-premium-1', 'claude-premium-3', 'claude-premium-2', 'claude-ultra']
 WHERE slug = 'quality-judge';
UPDATE harness.agents
   SET alt_provider = 'claude', alt_model = 'claude-opus-5-5',
       fallback_accounts = ARRAY['claude-ultra', 'claude-premium-5', 'claude-premium-1', 'claude-premium-4', 'claude-premium-3', 'claude-premium-2']
 WHERE slug = 'locale-checker';

-- Every Claude agent may use all six Claude seats (its own order first).
UPDATE harness.agents a
   SET fallback_accounts = a.fallback_accounts || ARRAY(
         SELECT s.id FROM unnest(ARRAY['claude-ultra', 'claude-premium-1', 'claude-premium-2', 'claude-premium-3', 'claude-premium-4', 'claude-premium-5']) AS s(id)
          WHERE s.id <> a.primary_account AND s.id <> ALL (a.fallback_accounts)
            AND EXISTS (SELECT 1 FROM harness.accounts x WHERE x.id = s.id))
 WHERE a.provider = 'claude';

-- A seat's limit is enforced where the run starts, under a lock on the seat: two jobs that picked the same seat at
-- the same moment cannot both take its last place. The loser gets 'seat full' and the worker picks another seat.
CREATE OR REPLACE FUNCTION harness.start_run(p_job uuid, p_token uuid, p_agent text, p_account text, p_provider text, p_model text, p_prompt_version text, p_worker text)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  v_id  uuid;
  v_max integer;
BEGIN
  PERFORM 1 FROM harness.jobs WHERE id = p_job AND status = 'running' AND lease_token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT max_parallel INTO v_max FROM harness.accounts WHERE id = p_account FOR UPDATE;
  -- A run older than 15 minutes is a leftover (no agent runs that long), not a live one.
  IF v_max IS NOT NULL AND (SELECT count(*) FROM harness.runs
                             WHERE account_id = p_account AND status = 'running' AND started_at > now() - interval '15 minutes') >= v_max THEN
    RAISE EXCEPTION 'seat full: %', p_account USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO harness.runs (job_id, agent_slug, account_id, provider, model, prompt_version, worker)
  VALUES (p_job, p_agent, p_account, p_provider, p_model, p_prompt_version, p_worker)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION harness.start_run(uuid, uuid, text, text, text, text, text, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.start_run(uuid, uuid, text, text, text, text, text, text) TO service_role';
  END IF;
END $$;

-- No daily cap (the column's own maximum) and more runs at once.
UPDATE harness.settings SET daily_run_limit = 100000, max_concurrent_runs = 5, updated_at = now() WHERE id;

-- Check jobs for the show pack go first: a person is waiting to approve it.
UPDATE harness.jobs SET priority = 0 WHERE kind = 'show_check' AND status = 'queued';

NOTIFY pgrst, 'reload schema';
