-- The 45s between-games break (and rules_version 3) only reach tournaments
-- created after deploy: config is frozen at creation. The Aug-29 row was
-- pre-created with break_ms=120000, so without this it would still run
-- 2-minute breaks. Applies to every not-yet-finished real tournament.
UPDATE wl_tournaments
SET config = config
  || jsonb_build_object('break_ms', 45000)
  || jsonb_build_object('rules_version', 3)
WHERE status NOT IN ('completed', 'cancelled')
  AND is_test = false;
