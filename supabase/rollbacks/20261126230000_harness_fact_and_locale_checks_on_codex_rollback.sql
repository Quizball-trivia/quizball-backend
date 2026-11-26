UPDATE harness.agents SET alt_provider = 'claude', alt_model = 'claude-sonnet-5-5',
       fallback_accounts = ARRAY['claude-premium-1', 'claude-premium-4', 'claude-premium-5', 'claude-premium-2', 'claude-premium-3', 'claude-ultra']
 WHERE slug = 'fact-checker';
UPDATE harness.agents SET alt_provider = 'claude', alt_model = 'claude-opus-5-5',
       fallback_accounts = ARRAY['claude-ultra', 'claude-premium-5', 'claude-premium-1', 'claude-premium-4', 'claude-premium-3', 'claude-premium-2']
 WHERE slug = 'locale-checker';
UPDATE harness.accounts SET max_parallel = 3 WHERE id = 'codex-1';
