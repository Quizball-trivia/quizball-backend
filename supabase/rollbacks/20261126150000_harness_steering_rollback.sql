DELETE FROM harness.policies WHERE key = 'content.direction';
DROP INDEX IF EXISTS harness.harness_briefs_requests;
ALTER TABLE harness.briefs DROP COLUMN IF EXISTS requested_by, DROP COLUMN IF EXISTS deadline, DROP COLUMN IF EXISTS topic, DROP COLUMN IF EXISTS source;
DROP TABLE IF EXISTS harness.steering;
