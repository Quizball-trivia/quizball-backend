-- Auction match persistence.
--
-- Auction is a 3-player mode that, until now, lived only in Redis and was never
-- written to Postgres — so auction games never appeared in Recent Matches or
-- stats. This migration lets auction reuse the same `matches` / `match_players`
-- persistence that ranked / friendly / party-quiz already use:
--   • allow mode = 'auction' on matches and user_mode_match_stats
--   • add match_players.placement so a 3-player finishing order (1st/2nd/3rd)
--     can be recorded (1v1 modes leave it NULL).
-- match_players.seat is already CHECK (seat BETWEEN 1 AND 6) from the party-quiz
-- expansion, so 3 seats need no change here.

-- 1) matches.mode — add 'auction'
ALTER TABLE public.matches
  DROP CONSTRAINT IF EXISTS matches_mode_check;
ALTER TABLE public.matches
  ADD CONSTRAINT matches_mode_check
  CHECK (mode IN ('friendly', 'ranked', 'auction'));

-- 2) user_mode_match_stats.mode — add 'auction'
ALTER TABLE public.user_mode_match_stats
  DROP CONSTRAINT IF EXISTS user_mode_match_stats_mode_check;
ALTER TABLE public.user_mode_match_stats
  ADD CONSTRAINT user_mode_match_stats_mode_check
  CHECK (mode IN ('ranked', 'friendly', 'auction'));

-- 3) match_players.placement — finishing order for multi-player modes (auction).
--    NULL for 1v1 modes; 1 = winner (highest team value).
ALTER TABLE public.match_players
  ADD COLUMN IF NOT EXISTS placement smallint NULL;
ALTER TABLE public.match_players
  DROP CONSTRAINT IF EXISTS match_players_placement_check;
ALTER TABLE public.match_players
  ADD CONSTRAINT match_players_placement_check
  CHECK (placement IS NULL OR placement BETWEEN 1 AND 6);

-- 4) matches.category_a_id — quiz modes always have a category, but auction is
--    not a quiz (no categories, no questions). Make it nullable so non-quiz
--    modes can persist without storing a meaningless placeholder category.
ALTER TABLE public.matches
  ALTER COLUMN category_a_id DROP NOT NULL;
