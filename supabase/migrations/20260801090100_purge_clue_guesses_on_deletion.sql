-- Purge clue_guess_evaluations when an account deletion finalizes.
--
-- WHY: finalize_pending_account_deletions() ANONYMIZES the public.users row
-- (email/nickname/country nulled, is_deleted set) rather than deleting it, so
-- nothing cascades. clue_guess_evaluations holds free text the player typed,
-- keyed to user_id, and would otherwise survive their deletion indefinitely.
-- The function already deletes nickname_history for exactly this reason; this
-- adds the same treatment for guesses.
--
-- Body is byte-identical to 20260728130100 except for the single DELETE added
-- next to the nickname_history purge. Keep in sync if that function changes.

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
      AND is_ai = false
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

  DELETE FROM public.nickname_history
  WHERE user_id = ANY(expired_user_ids);

  -- Free text the player typed; anonymizing the users row does not reach it.
  DELETE FROM public.clue_guess_evaluations
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

  -- Same reset the season rollover applies (keep in sync with 20260721000100).
  UPDATE public.ranked_profiles
  SET rp = 0, tier = 'Academy', placement_status = 'unplaced',
      placement_played = 0, placement_wins = 0, placement_seed_rp = NULL,
      placement_perf_sum = 0, placement_points_for_sum = 0,
      placement_points_against_sum = 0, current_win_streak = 0, updated_at = NOW()
  WHERE user_id = ANY(expired_user_ids);

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
