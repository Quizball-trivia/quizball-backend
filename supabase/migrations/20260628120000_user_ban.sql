-- Account ban (soft, reversible).
--
-- Blocks login for abusive accounts while preserving ALL history so a ban can be
-- lifted later. `ban_metadata` snapshots state that the ban action mutates (e.g.
-- pre-ban RP), so unban can restore it. This is intentionally NOT account
-- deletion: rows, matches, RP history, and identities are all kept intact.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_banned boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS banned_at timestamptz,
  ADD COLUMN IF NOT EXISTS ban_reason text,
  ADD COLUMN IF NOT EXISTS ban_metadata jsonb;

-- Partial index: ban enforcement and the admin "banned users" view only ever
-- look at banned rows, which are a tiny minority — keep the index small.
CREATE INDEX IF NOT EXISTS idx_users_is_banned
  ON users (banned_at DESC)
  WHERE is_banned = true;

COMMENT ON COLUMN users.is_banned IS 'Soft ban: when true, auth is rejected for this account. Reversible.';
COMMENT ON COLUMN users.ban_metadata IS 'Snapshot of state mutated by the ban (e.g. {"prev_rp":14966,"prev_tier":"...","prev_placement":"placed"}) so unban can restore it.';
