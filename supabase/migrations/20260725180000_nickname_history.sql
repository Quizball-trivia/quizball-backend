-- Nickname change limits + public name history.
--
-- Today nickname changes are unrestricted and unlogged: users.updated_at is
-- useless as a rename timestamp (the 4-hourly ticket-refill cron touches every
-- row) and audit_logs has no nickname records, so support cannot answer "when
-- did this player rename, and from what?" — which has already blocked
-- leaderboard-integrity and smurf investigations.
--
-- This table is the SINGLE SOURCE OF TRUTH for the change quota (2 free
-- changes, then a rolling 30-day cooldown). Deliberately no counter columns on
-- `users`: a second counter would drift from this table on any partial failure
-- or support fix, and reading it through the 60s user cache would open a
-- rename-spam window. The quota is derived inside the write transaction.
--
-- Idempotent: safe under manual apply + deploy runner re-run.
CREATE TABLE IF NOT EXISTS nickname_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- NULL when there is no publishable predecessor: the very first name, or a
  -- predecessor that was the user's OAuth-derived real name (see identity_derived).
  old_nickname text,
  new_nickname text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  -- 'signup' marks the one-shot free naming pass consumed during onboarding.
  -- It is an explicit marker, not a row-count proxy: an uncounted row never
  -- increments the counted total, so counting rows would leave every
  -- pre-onboarding rename free forever.
  changed_by text NOT NULL DEFAULT 'user'
    CHECK (changed_by IN ('user', 'signup', 'admin', 'system')),
  -- false = excluded from the quota (onboarding pass, admin/moderation rename,
  -- case-only cosmetic edit).
  counted boolean NOT NULL DEFAULT true,
  -- true when new_nickname came from an OAuth identity (identity.name), i.e. the
  -- user's real Google/Facebook name. Such names must never be published as a
  -- later row's old_nickname.
  identity_derived boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS nickname_history_user_idx
  ON nickname_history (user_id, changed_at DESC);

-- Freed-name reservation lookup: block reclaiming a name another user vacated
-- within the last 30 days, so publishing history can't be used to impersonate
-- a player who just renamed.
CREATE INDEX IF NOT EXISTS nickname_history_old_lower_idx
  ON nickname_history (lower(old_nickname))
  WHERE old_nickname IS NOT NULL;

-- RLS on with no policy = deny-all for anon/authenticated. The backend uses the
-- service role, which bypasses RLS. This mirrors the lockdown established by
-- migration 20260702000000 (enable_rls_all_public_tables).
ALTER TABLE nickname_history ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE nickname_history IS
  'Rename audit + source of truth for the nickname change quota. Not a complete audit of every users.nickname write: the deletion finalizer scrubs names directly.';
COMMENT ON COLUMN nickname_history.counted IS
  'Counts against the 2-free-changes quota. False for the onboarding pass, admin renames and case-only edits.';
COMMENT ON COLUMN nickname_history.identity_derived IS
  'new_nickname came from OAuth identity.name (real name). Never publish such a value as a later old_nickname.';
