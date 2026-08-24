-- Split from 20260727130000 for the prod promotion, and built NON-concurrently:
-- the migration runner's advisory-lock connection sits idle-in-transaction for
-- the whole run, so CREATE INDEX CONCURRENTLY self-deadlocks waiting on its
-- virtualxid (proved in the prod-schema dry-run). The plain build takes a
-- SHARE lock on users for one sub-second scan (the partial predicate matches
-- zero rows at migration time — every auction_points is 0). lock_timeout
-- fails the deploy cleanly rather than queueing behind live traffic.
-- Environments that already carry the index (staging) no-op via IF NOT EXISTS.
SET LOCAL lock_timeout = '5s';

-- Leaderboard ordering + own-rank counting. Partial on `auction_points > 0`:
-- users who never played a queue auction can never place, so excluding them
-- keeps this index proportional to auction players, not total registered users.
-- The tiebreaker mirrors ranked's (score DESC, updated_at ASC) so the earlier
-- arrival at a score ranks higher and ordering stays stable across pages.
CREATE INDEX IF NOT EXISTS idx_users_auction_points_desc
  ON public.users (auction_points DESC, updated_at ASC)
  WHERE auction_points > 0;
