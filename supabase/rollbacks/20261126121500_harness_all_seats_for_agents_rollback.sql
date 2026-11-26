UPDATE harness.agents SET fallback_accounts = ARRAY['claude-premium-1', 'claude-premium-4'] WHERE slug = 'question-maker';
UPDATE harness.agents SET fallback_accounts = ARRAY['claude-premium-4', 'claude-premium-1'] WHERE slug = 'localizer';
UPDATE harness.agents SET fallback_accounts = ARRAY['claude-premium-4'] WHERE slug = 'content-planner';
DELETE FROM harness.accounts WHERE id = 'claude-premium-5' AND NOT EXISTS (SELECT 1 FROM harness.runs WHERE account_id = 'claude-premium-5');
INSERT INTO harness.accounts (id, provider, label, secret_ref, status, reserved_for_people)
VALUES ('claude-people', 'claude', 'nika@quizball.io seat: people only', 'HARNESS_NEVER_USED', 'disabled', true) ON CONFLICT (id) DO NOTHING;
