-- =============================================================================
-- Migration: football_grid_points
-- Description: Tic Tac Toe Points (TP) — the Football Grid mode's own
--              leaderboard currency, mirroring auction_points
--              (20260727130000_auction_points.sql) exactly: an award-only
--              counter on users. Random-queue grid matches pay by result
--              (win +50, draw +30, loss +10). Normal awards only increase TP;
--              audited fraud reversals may decrease it. TP has no starting
--              value, no tiers and no seasonal reset.
--
-- Same shape rationale as auction_points: RP needs ranked_profiles because it
-- carries per-user state (tier, placements, streaks) and a ledger; TP is a
-- single monotonic counter, so it lives on users next to coins and
-- auction_points. Promoting it to its own table later is a contained migration.
--
-- Query patterns:
--   1. Award on grid settlement (once per match, inside the settlement tx):
--        UPDATE users
--           SET tic_tac_toe_points = tic_tac_toe_points + $1,
--               tic_tac_toe_points_updated_at = now()
--         WHERE id = $2
-- The leaderboard index and the auditable point-event ledger are installed by
-- follow-up migrations so this ACCESS EXCLUSIVE users-table change stays short.
-- =============================================================================

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS tic_tac_toe_points integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tic_tac_toe_points_updated_at timestamptz;

-- Add checks without validating existing rows while ACCESS EXCLUSIVE is held.
-- Validation runs in a later migration with a weaker table lock.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.users'::regclass
       AND conname = 'users_tic_tac_toe_points_nonnegative_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_tic_tac_toe_points_nonnegative_check
      CHECK (tic_tac_toe_points >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.users'::regclass
       AND conname = 'users_tic_tac_toe_points_timestamp_check'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_tic_tac_toe_points_timestamp_check CHECK (
        (tic_tac_toe_points = 0 AND tic_tac_toe_points_updated_at IS NULL)
        OR (tic_tac_toe_points > 0 AND tic_tac_toe_points_updated_at IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;
