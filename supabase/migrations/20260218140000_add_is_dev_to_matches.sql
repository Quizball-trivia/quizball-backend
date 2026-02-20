-- Add is_dev flag to matches table to identify dev/test matches
ALTER TABLE public.matches ADD COLUMN IF NOT EXISTS is_dev boolean NOT NULL DEFAULT false;

-- Index for efficient cleanup queries
CREATE INDEX IF NOT EXISTS idx_matches_is_dev ON public.matches (is_dev) WHERE is_dev = true;

-- Retroactively mark existing matches that have an AI player as dev matches
UPDATE public.matches m
SET is_dev = true
WHERE EXISTS (
  SELECT 1
  FROM match_players mp
  JOIN users u ON u.id = mp.user_id
  WHERE mp.match_id = m.id AND u.is_ai = true
);

-- Recalculate user_mode_match_stats by removing dev match contributions.
-- Strategy: delete all stats and rebuild from non-dev completed matches only.
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
