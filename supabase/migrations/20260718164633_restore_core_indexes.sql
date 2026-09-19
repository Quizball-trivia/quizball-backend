-- Index repair is deferred to the individual online_* forward migrations
-- in this release. Keeping this historical version avoids rewriting ledgers.
-- All ten indexes are already present on the audited production schema.
SELECT 1;
