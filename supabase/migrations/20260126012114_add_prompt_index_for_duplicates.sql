-- Add index for fast duplicate checking during bulk upload
-- Uses normalized prompt (lowercase, trimmed) from English text
--
-- IMPORTANT: This creates the index non-concurrently (locks table for writes).
-- If running on a production database with significant data, consider using:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_questions_prompt_normalized
--   ON questions ((LOWER(TRIM(prompt->>'en'))));
-- (Note: CONCURRENTLY cannot be used inside a transaction block)
--
-- For new/small databases, the standard CREATE INDEX is fine.

CREATE INDEX IF NOT EXISTS idx_questions_prompt_normalized
ON questions ((LOWER(TRIM(prompt->>'en'))));

-- Add comment to document purpose
COMMENT ON INDEX idx_questions_prompt_normalized IS
'Index for fast duplicate question detection using normalized English prompt text. Used by check-duplicates endpoint for bulk upload preview.';
