-- Fact and language checks go back to Codex only (HQ, straight to prod).
-- Measured on 2026-11-26 after checks started overflowing to Claude seats
-- (same queue, split by which seat was free):
--   facts:     Codex sent back 7% of questions (wrong years, wrong records);
--              Sonnet sent back 1%, so it was passing errors Codex catches.
--   languages: Codex found something to fix in 10% of translations, Opus in 3%.
--   quality:   no difference on medium and hard; Sonnet is stricter on easy.
-- A weaker fact check is worse than a slower one, so those two checkers wait
-- for Codex again. The Quality Judge keeps its Claude overflow (stricter is
-- safe). Codex takes one more run at once to make up for it.
UPDATE harness.agents
   SET alt_provider = NULL, alt_model = NULL, alt_effort = NULL, fallback_accounts = '{}'
 WHERE slug IN ('fact-checker', 'locale-checker');
UPDATE harness.accounts SET max_parallel = 4 WHERE id = 'codex-1';
