-- Fix: ranked matches against AI were incorrectly marked as is_dev.
-- Only friendly/non-ranked matches with AI players are dev matches.
-- Ranked AI matches should count towards user stats.

-- 1. Unmark ranked AI matches
UPDATE public.matches m
SET is_dev = false
WHERE m.mode = 'ranked'
  AND m.is_dev = true;

-- 2. Rebuild user_mode_match_stats to restore ranked AI match contributions.
BEGIN;

DELETE FROM public.user_mode_match_stats;

INSERT INTO public.user_mode_match_stats (
  user_id, mode, games_played, wins, losses, draws, last_match_at, updated_at
)
SELECT
  mp.user_id,
  m.mode,
  COUNT(*)::int AS games_played,
  COUNT(*) FILTER (WHERE m.winner_user_id = mp.user_id)::int AS wins,
  COUNT(*) FILTER (WHERE m.winner_user_id IS NOT NULL AND m.winner_user_id <> mp.user_id)::int AS losses,
  COUNT(*) FILTER (WHERE m.winner_user_id IS NULL)::int AS draws,
  MAX(m.ended_at) AS last_match_at,
  NOW() AS updated_at
FROM match_players mp
JOIN matches m ON m.id = mp.match_id
WHERE m.status = 'completed'
  AND m.is_dev = false
GROUP BY mp.user_id, m.mode
ON CONFLICT (user_id, mode) DO UPDATE
SET
  games_played = EXCLUDED.games_played,
  wins = EXCLUDED.wins,
  losses = EXCLUDED.losses,
  draws = EXCLUDED.draws,
  last_match_at = EXCLUDED.last_match_at,
  updated_at = NOW();

COMMIT;
