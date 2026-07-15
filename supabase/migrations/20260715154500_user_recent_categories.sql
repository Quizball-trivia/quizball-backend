-- =============================================================================
-- Migration: user_recent_categories (re-versioned after a duplicate timestamp
-- collision with 20260610150000_placement_seed_cap_reserve.sql)
-- Description: Tracks the categories a user ACTUALLY PLAYED in ranked matches
--              (saved when a drafted category is finalized, not merely shown),
--              so the ranked draft can avoid re-offering recently played
--              categories. Capped at the newest 10 rows per (user, mode) at
--              write time.
--
-- Query patterns this must serve (hot path = ranked draft start):
--   1. Fetch recents for the 1-2 users of a match:
--        SELECT user_id, category_id, played_at
--        FROM user_recent_categories
--        WHERE user_id = ANY($1) AND mode = $2
--        ORDER BY played_at DESC
--      -> idx_user_recent_categories_user_mode_played (index scan, <=10 rows/user)
--   2. Upsert on play (dedupe: replaying a category bumps it to newest):
--        ON CONFLICT (user_id, mode, category_id) DO UPDATE played_at = NOW()
--      -> unique constraint below
--   3. Trim overflow beyond the newest 10 per (user, mode)
--      -> same composite index drives the window scan
-- =============================================================================

CREATE TABLE IF NOT EXISTS user_recent_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  -- Scope: 'ranked' today; future events (e.g. a dedicated World Cup ranked
  -- event id) get their own value so recents are tracked per mode/event.
  mode TEXT NOT NULL DEFAULT 'ranked',
  played_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Dedupe anchor: one row per (user, mode, category); replays bump played_at.
  CONSTRAINT user_recent_categories_user_mode_category_key
    UNIQUE (user_id, mode, category_id)
);

-- `CREATE TABLE IF NOT EXISTS` does not repair a pre-existing partial table.
-- Ensure the ON CONFLICT(user_id, mode, category_id) anchor exists even on a
-- project where this table was created before the migration registry was fixed.
CREATE UNIQUE INDEX IF NOT EXISTS user_recent_categories_user_mode_category_key
  ON user_recent_categories (user_id, mode, category_id);

-- Newest-first reads + overflow trimming per (user, mode).
CREATE INDEX IF NOT EXISTS idx_user_recent_categories_user_mode_played
  ON user_recent_categories (user_id, mode, played_at DESC);
