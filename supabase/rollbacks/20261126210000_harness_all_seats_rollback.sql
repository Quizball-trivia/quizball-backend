UPDATE harness.agents SET fallback_accounts = '{}' WHERE provider = 'codex';
ALTER TABLE harness.agents DROP CONSTRAINT IF EXISTS harness_agents_alt_complete, DROP CONSTRAINT IF EXISTS harness_agents_alt_differs,
  DROP COLUMN IF EXISTS alt_provider, DROP COLUMN IF EXISTS alt_model, DROP COLUMN IF EXISTS alt_effort;
ALTER TABLE harness.accounts DROP COLUMN IF EXISTS max_parallel;
UPDATE harness.settings SET daily_run_limit = 1500, max_concurrent_runs = 3, updated_at = now() WHERE id;
NOTIFY pgrst, 'reload schema';
