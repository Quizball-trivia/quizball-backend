-- Restores only the arrays the forward migration produced; custom settings stay.
UPDATE harness.agents SET fallback_accounts = ARRAY['claude-premium-1', 'claude-premium-4']
 WHERE slug = 'question-maker' AND fallback_accounts = ARRAY['claude-premium-1', 'claude-premium-5', 'claude-premium-4'];
UPDATE harness.agents SET fallback_accounts = ARRAY['claude-premium-4', 'claude-premium-1']
 WHERE slug = 'localizer' AND fallback_accounts = ARRAY['claude-premium-5', 'claude-premium-4', 'claude-premium-1'];
UPDATE harness.agents SET fallback_accounts = ARRAY['claude-premium-4']
 WHERE slug = 'content-planner' AND fallback_accounts = ARRAY['claude-premium-4', 'claude-premium-5'];
DELETE FROM harness.accounts a WHERE a.id = 'claude-premium-5'
   AND NOT EXISTS (SELECT 1 FROM harness.runs r WHERE r.account_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM harness.agents g WHERE g.primary_account = a.id OR a.id = ANY (g.fallback_accounts));
INSERT INTO harness.accounts (id, provider, label, secret_ref, status, reserved_for_people)
VALUES ('claude-people', 'claude', 'nika@quizball.io seat: people only', 'HARNESS_NEVER_USED', 'disabled', true) ON CONFLICT (id) DO NOTHING;
