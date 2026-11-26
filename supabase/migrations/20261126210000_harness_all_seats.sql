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
-- Claude seats. Facts, quality and the show pack check English/Georgian text
-- written by Opus or taken from the bank: Sonnet. Translations are written by
-- Sonnet: Opus checks those.
UPDATE harness.agents
   SET alt_provider = 'claude', alt_model = 'claude-sonnet-5-5',
       fallback_accounts = ARRAY['claude-premium-1', 'claude-premium-4', 'claude-premium-5', 'claude-premium-2', 'claude-premium-3', 'claude-ultra']
 WHERE slug IN ('fact-checker', 'show-checker');
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

-- No daily cap (the column's own maximum) and more runs at once.
UPDATE harness.settings SET daily_run_limit = 100000, max_concurrent_runs = 5, updated_at = now() WHERE id;

-- Check jobs for the show pack go first: a person is waiting to approve it.
UPDATE harness.jobs SET priority = 0 WHERE kind = 'show_check' AND status = 'queued';

NOTIFY pgrst, 'reload schema';
