-- Add is_ai flag to users table to distinguish AI-generated users from real users
ALTER TABLE users ADD COLUMN is_ai BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing AI users: no email, not onboarded, and no identity row
UPDATE users u
SET is_ai = true
WHERE u.email IS NULL
  AND u.onboarding_complete = false
  AND NOT EXISTS (
    SELECT 1 FROM user_identities ui WHERE ui.user_id = u.id
  );

-- Partial index for cleanup queries targeting AI users by age
CREATE INDEX idx_users_is_ai_created ON users (created_at) WHERE is_ai = true;

-- RPC function called by pg_cron to delete stale AI users
CREATE OR REPLACE FUNCTION cleanup_ai_users()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM users
  WHERE is_ai = true
    AND created_at < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- Restrict execution: only postgres (used by pg_cron) can call this function
REVOKE EXECUTE ON FUNCTION cleanup_ai_users() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION cleanup_ai_users() FROM anon;
REVOKE EXECUTE ON FUNCTION cleanup_ai_users() FROM authenticated;
