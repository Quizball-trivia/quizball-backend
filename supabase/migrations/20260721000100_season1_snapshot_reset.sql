-- Season 1 rollover: archive the live ranked board (final standings + full RP
-- history) under a batch stamped season_number = 1, then zero every real
-- user's profile so Season 2 starts fresh under the new tier curve that ships
-- with this deploy. Runs in the pre-deploy migration step, so the snapshot is
-- taken while the previous app version (old curve) is still serving.
-- Exactly-once per environment: no-op wherever a Season 1 batch already
-- exists (staging ran the identical rollover by hand on 2026-07-20).
DO $$
DECLARE
  batch_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM ranked_reset_batches WHERE season_number = 1) THEN
    RAISE NOTICE 'Season 1 batch already present - skipping rollover';
    RETURN;
  END IF;

  INSERT INTO ranked_reset_batches (triggered_by, notes, season_number)
  VALUES (NULL, 'Season 1 final standings - automated rollover', 1)
  RETURNING id INTO batch_id;

  INSERT INTO ranked_profiles_archive (
    reset_batch_id, user_id, rp, tier, placement_status,
    placement_required, placement_played, placement_wins, placement_seed_rp,
    placement_perf_sum, placement_points_for_sum, placement_points_against_sum,
    current_win_streak, last_ranked_match_at
  )
  SELECT
    batch_id, user_id, rp, tier, placement_status,
    placement_required, placement_played, placement_wins, placement_seed_rp,
    placement_perf_sum, placement_points_for_sum, placement_points_against_sum,
    current_win_streak, last_ranked_match_at
  FROM ranked_profiles;

  INSERT INTO ranked_rp_changes_archive (
    reset_batch_id, match_id, user_id, opponent_user_id, opponent_is_ai,
    old_rp, delta_rp, new_rp, result, is_placement, placement_game_no,
    placement_anchor_rp, placement_perf_score, calculation_method, source_created_at
  )
  SELECT
    batch_id, match_id, user_id, opponent_user_id, opponent_is_ai,
    old_rp, delta_rp, new_rp, result, is_placement, placement_game_no,
    placement_anchor_rp, placement_perf_score, calculation_method, created_at
  FROM ranked_rp_changes;

  UPDATE ranked_profiles rp
  SET rp = 0, tier = 'Academy', placement_status = 'unplaced',
      placement_played = 0, placement_wins = 0, placement_seed_rp = NULL,
      placement_perf_sum = 0, placement_points_for_sum = 0,
      placement_points_against_sum = 0, current_win_streak = 0, updated_at = NOW()
  WHERE EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = rp.user_id AND u.is_ai = false AND u.is_seed = false
      AND u.is_deleted = false AND u.deleted_at IS NULL AND u.pending_deletion_at IS NULL
  );

  UPDATE ranked_reset_batches SET completed_at = NOW() WHERE id = batch_id;
END $$;
