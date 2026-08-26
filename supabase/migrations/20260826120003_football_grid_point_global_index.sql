-- migrate:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_tic_tac_toe_points_desc
  ON public.users (
    tic_tac_toe_points DESC,
    tic_tac_toe_points_updated_at ASC,
    id ASC
  )
  WHERE tic_tac_toe_points > 0
    AND is_ai = false
    AND is_seed = false
    AND is_deleted = false
    AND deleted_at IS NULL
    AND pending_deletion_at IS NULL;
