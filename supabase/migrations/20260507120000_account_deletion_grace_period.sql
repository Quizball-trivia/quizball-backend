-- Two-stage account deletion:
-- 1. pending_deletion_at locks and hides the account for the 30-day grace period.
-- 2. finalize_pending_account_deletions() anonymizes expired rows and frees Supabase Auth email reuse.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pending_deletion_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_users_pending_deletion_at
  ON users (pending_deletion_at)
  WHERE pending_deletion_at IS NOT NULL
    AND deleted_at IS NULL
    AND is_deleted = false;

CREATE INDEX IF NOT EXISTS idx_users_active_public
  ON users (is_ai, nickname)
  WHERE is_deleted = false
    AND deleted_at IS NULL
    AND pending_deletion_at IS NULL;

CREATE OR REPLACE FUNCTION finalize_pending_account_deletions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  expired_user_ids uuid[];
  auth_user_ids uuid[];
  finalized_count integer := 0;
BEGIN
  SELECT ARRAY_AGG(id)
  INTO expired_user_ids
  FROM (
    SELECT id
    FROM public.users
    WHERE pending_deletion_at IS NOT NULL
      AND pending_deletion_at <= NOW()
      AND deleted_at IS NULL
      AND is_deleted = false
    FOR UPDATE
  ) expired;

  IF expired_user_ids IS NULL OR ARRAY_LENGTH(expired_user_ids, 1) IS NULL THEN
    RETURN 0;
  END IF;

  -- Cast to uuid only after the regex filter has rejected malformed subjects.
  -- Postgres doesn't guarantee predicate evaluation order in WHERE, so a single-stage
  -- query risks `subject::uuid` running first and throwing on garbage data.
  SELECT ARRAY_AGG(DISTINCT subject::uuid)
  INTO auth_user_ids
  FROM (
    SELECT subject
    FROM public.user_identities
    WHERE user_id = ANY(expired_user_ids)
      AND provider = 'supabase'
      AND subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) valid_subjects;

  DELETE FROM public.user_identities
  WHERE user_id = ANY(expired_user_ids);

  UPDATE public.users
  SET
    email = NULL,
    nickname = 'Deleted Player',
    country = NULL,
    avatar_url = NULL,
    avatar_customization = NULL,
    favorite_club = NULL,
    deletion_requested_at = NULL,
    pending_deletion_at = NULL,
    deleted_at = NOW(),
    is_deleted = true,
    updated_at = NOW()
  WHERE id = ANY(expired_user_ids)
    AND deleted_at IS NULL
    AND is_deleted = false;

  GET DIAGNOSTICS finalized_count = ROW_COUNT;

  IF auth_user_ids IS NOT NULL AND ARRAY_LENGTH(auth_user_ids, 1) IS NOT NULL THEN
    DELETE FROM auth.users
    WHERE id = ANY(auth_user_ids);
  END IF;

  RETURN finalized_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION finalize_pending_account_deletions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finalize_pending_account_deletions() FROM anon;
REVOKE EXECUTE ON FUNCTION finalize_pending_account_deletions() FROM authenticated;

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'finalize-account-deletions-daily') THEN
    PERFORM cron.unschedule('finalize-account-deletions-daily');
  END IF;
END;
$$;

SELECT cron.schedule(
  'finalize-account-deletions-daily',
  '0 4 * * *',
  'SELECT finalize_pending_account_deletions()'
);
