-- =============================================================================
-- Migration: auction_points
-- Description: Auction Points (AP) — the auction mode's own leaderboard currency.
--              QUEUE auction matches pay by final placement (1st +50, 2nd +30,
--              3rd +10). AP is award-only: it never decreases, has no starting
--              value, no tiers, no placement calibration and no seasonal reset.
--
-- Why a users column instead of an `auction_profiles` table (the ranked shape):
--   ranked_profiles exists because RP carries per-user STATE beyond the score —
--   tier, placement_status/played/wins, seed + perf sums, win streak — plus an
--   immutable ranked_rp_changes ledger and archive tables to support season
--   resets. AP has none of that: it is a single monotonic counter with no
--   derived state and no reset story. A dedicated table would add a JOIN and a
--   row-provisioning path (ensureProfile) to store one integer, and would force
--   every new user to be back-filled before they could appear on the board.
--   users.coins (20260218180000_store_mvp) is the existing precedent for exactly
--   this shape — a plain award-only counter on users — so AP mirrors coins, not
--   ranked. If AP later grows seasons/tiers, promoting it to its own table is a
--   contained migration (the leaderboard query is the only reader).
--
-- Query patterns this must serve:
--   1. Award on auction finish (once per match, gated by the caller):
--        UPDATE users SET auction_points = auction_points + $1 WHERE id = $2
--      -> primary key, no index needed
--   2. Top-N leaderboard, bots/seed/deleted users excluded, AP > 0 only:
--        SELECT ... FROM users
--        WHERE is_ai = false AND is_seed = false AND is_deleted = false
--          AND deleted_at IS NULL AND pending_deletion_at IS NULL
--          AND auction_points > 0
--        ORDER BY auction_points DESC, updated_at ASC LIMIT $1 OFFSET $2
--      -> idx_users_auction_points_desc (partial: only earners are ever ranked,
--         which keeps the index tiny next to the full users table)
--   3. Requesting user's own rank = COUNT(*) of eligible rows scoring higher
--      -> same partial index (index-only count)
-- =============================================================================

-- Lock-hardened for prod promotion (2026-08-24): users is the hottest table.
-- The column add is metadata-only (constant default) but must never queue
-- behind other locks; the index build is CONCURRENTLY so it cannot block
-- writes (the migration runner applies CONCURRENTLY files statement-by-
-- statement with autocommit).
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS auction_points integer NOT NULL DEFAULT 0
    CHECK (auction_points >= 0);
