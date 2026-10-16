-- Club boards filter users by lower(btrim(favorite_club)) joined to leaderboard_club_aliases.
-- One online index per file: built without blocking writes to users.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_favorite_club_alias
  ON public.users ((lower(btrim(favorite_club))))
  WHERE favorite_club IS NOT NULL;
