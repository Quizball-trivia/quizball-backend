-- Purge nickname_history when an account deletion is finalized.
--
-- ON DELETE CASCADE is NOT sufficient here: finalize_pending_account_deletions()
-- performs a SOFT delete — it anonymizes the users row (nickname => 'Deleted
-- Player', is_deleted => true) and never removes it, so the FK cascade never
-- fires. Without this, a deleted user's previous nicknames — which for an OAuth
-- signup can include their real Google/Facebook name — would remain stored and
-- publicly servable forever after they asked to be erased.
--
-- Only the DELETE FROM public.nickname_history line is new; the rest of the
-- function is reproduced verbatim from 20260507120000_account_deletion_grace_period.sql
-- because CREATE OR REPLACE FUNCTION must restate the whole body.
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

  -- NEW: erase rename history for finalized accounts (see header).
  DELETE FROM public.nickname_history
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

-- Re-assert the original execution restrictions: CREATE OR REPLACE resets grants,
-- and this SECURITY DEFINER function anonymizes users.
REVOKE EXECUTE ON FUNCTION finalize_pending_account_deletions() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION finalize_pending_account_deletions() FROM anon;
REVOKE EXECUTE ON FUNCTION finalize_pending_account_deletions() FROM authenticated;
