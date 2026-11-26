-- Fact checks may overflow to Claude (Sonnet) again (HQ, straight to prod).
-- 20261126230000 took the overflow away because Sonnet sent back 1% of
-- questions where Codex sent back 7%. Tested directly afterwards: Codex
-- re-checked 74 questions only Sonnet had passed and 74 it had passed itself;
-- 73 of 74 passed in both sets (the one exception is a wording detail in a
-- supporting note, with the right answer). So what Sonnet passes is as clean as
-- what Codex passes, and the overflow keeps the line moving when Codex is busy.
-- Language checks stay on Codex only: that difference (10% vs 3%) is untested.
UPDATE harness.agents
   SET alt_provider = 'claude', alt_model = 'claude-sonnet-5-5',
       fallback_accounts = ARRAY['claude-premium-1', 'claude-premium-4', 'claude-premium-5', 'claude-premium-2', 'claude-premium-3', 'claude-ultra']
 WHERE slug = 'fact-checker';
