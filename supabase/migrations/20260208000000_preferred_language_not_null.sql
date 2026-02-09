-- Backfill any NULL preferred_language values before adding NOT NULL constraint
UPDATE users SET preferred_language = 'en' WHERE preferred_language IS NULL;
ALTER TABLE users ALTER COLUMN preferred_language SET NOT NULL;
