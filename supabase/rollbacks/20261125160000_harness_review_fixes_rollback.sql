-- Rollback for 20261125160000_harness_review_fixes.sql: drops start_run.
-- classic_health keeps its new archived-question rule (harmless); re-run the
-- core migration's definition to restore the old one if ever needed.
DROP FUNCTION IF EXISTS harness.start_run(uuid, uuid, text, text, text, text, text, text);
