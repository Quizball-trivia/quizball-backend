-- Account-deletion finalization anonymized users but left their ranked_profiles
-- row untouched, so a finalized 'Deleted Player' could keep e.g. 8780 RP as a
-- ranked ghost. Harmless today (every public query filters deletion flags) but
-- a latent leak if any future query forgets. Finalization now resets the ranked
-- row with the same field list the season rollover uses (20260721000100), and a
-- one-time backfill below applies the same reset to already-finalized accounts.
-- Pending-deletion accounts are untouched: they can still cancel and must keep
-- their standing.
-- Body reproduced verbatim from 20260727150000_ai_kind_classification.sql with
-- ONE addition: the ranked_profiles reset after the users anonymization UPDATE.
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

-- One-time backfill: apply the same reset to ranked rows of accounts that were
-- already finalized before this migration. Pending-deletion accounts excluded.
-- Idempotent: only rows not already fully reset are touched.
UPDATE public.ranked_profiles p
SET rp = 0, tier = 'Academy', placement_status = 'unplaced',
    placement_played = 0, placement_wins = 0, placement_seed_rp = NULL,
    placement_perf_sum = 0, placement_points_for_sum = 0,
    placement_points_against_sum = 0, current_win_streak = 0, updated_at = NOW()
WHERE EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = p.user_id
      AND (u.is_deleted = true OR u.deleted_at IS NOT NULL)
  )
  AND (p.rp <> 0 OR p.tier <> 'Academy' OR p.placement_status <> 'unplaced'
    OR p.placement_played <> 0 OR p.placement_wins <> 0
    OR p.placement_seed_rp IS NOT NULL OR p.placement_perf_sum <> 0
    OR p.placement_points_for_sum <> 0 OR p.placement_points_against_sum <> 0
    OR p.current_win_streak <> 0);
