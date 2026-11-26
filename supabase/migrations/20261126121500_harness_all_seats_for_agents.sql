-- Owner decision 2026-11-26: every Claude subscription goes to agents. The
-- nika@quizball.io business seat is no longer kept for people: it becomes
-- premium seat 5, and the reserved placeholder row is removed.
-- Seats: ultra = nika@ (Personal Ultra); premium-1..5 = tazi@, cholo@,
-- nikaesebua@, tato@, nika@ (Quizball business org).

INSERT INTO harness.accounts (id, provider, label, secret_ref, status, reserved_for_people)
VALUES ('claude-premium-5', 'claude', 'Claude premium seat 5 (Making, Localization overflow)', 'HARNESS_CLAUDE_PREMIUM_5_TOKEN', 'active', false)
ON CONFLICT (id) DO NOTHING;

DELETE FROM harness.accounts a
 WHERE a.id = 'claude-people'
   AND NOT EXISTS (SELECT 1 FROM harness.runs r WHERE r.account_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM harness.agents g WHERE g.primary_account = a.id OR a.id = ANY (g.fallback_accounts));
UPDATE harness.accounts SET status = 'disabled', label = 'retired placeholder (was: people only)'
 WHERE id = 'claude-people';

-- Seat 5 backs the two heaviest Claude agents and the planner.
UPDATE harness.agents SET fallback_accounts = ARRAY['claude-premium-1', 'claude-premium-5', 'claude-premium-4'], updated_at = now()
 WHERE slug = 'question-maker' AND fallback_accounts = ARRAY['claude-premium-1', 'claude-premium-4'];
UPDATE harness.agents SET fallback_accounts = ARRAY['claude-premium-5', 'claude-premium-4', 'claude-premium-1'], updated_at = now()
 WHERE slug = 'localizer' AND fallback_accounts = ARRAY['claude-premium-4', 'claude-premium-1'];
UPDATE harness.agents SET fallback_accounts = ARRAY['claude-premium-4', 'claude-premium-5'], updated_at = now()
 WHERE slug = 'content-planner' AND fallback_accounts = ARRAY['claude-premium-4'];
