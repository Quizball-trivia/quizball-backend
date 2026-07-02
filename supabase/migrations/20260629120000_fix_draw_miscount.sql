-- Fix mis-counted "draws" in user_mode_match_stats.
--
-- Bug: the aggregate counted ANY completed match with winner_user_id IS NULL as
-- a draw. But abandoned / opponent-never-joined matches (only 1 player row) also
-- have a NULL winner, and the ranked RP system already scores those as LOSSES.
-- So those matches were a loss in RP but a draw on the profile — inflating
-- players' draw counts (e.g. ~4,455 ranked matches affected across all users).
--
-- A genuine draw requires BOTH players present (>= 2 match_players) and no
-- winner. This one-time recompute rebuilds the whole table with the corrected
-- classification (abandoned/solo matches count as a loss for the lone player,
-- matching RP), keeping wins/losses/draws/games_played consistent.

WITH corrected AS (
  SELECT
    mp.user_id,
    m.mode,
    COUNT(*)::int AS games_played,
    COUNT(*) FILTER (WHERE m.winner_user_id = mp.user_id)::int AS wins,
    -- Loss = an opponent won, OR no winner but it was not a real draw
    -- (fewer than 2 players present = abandoned/no-opponent).
    COUNT(*) FILTER (
      WHERE (m.winner_user_id IS NOT NULL AND m.winner_user_id <> mp.user_id)
         OR (m.winner_user_id IS NULL AND pc.player_count < 2)
    )::int AS losses,
    -- Draw = no winner AND both players were present.
    COUNT(*) FILTER (
      WHERE m.winner_user_id IS NULL AND pc.player_count >= 2
    )::int AS draws,
    MAX(m.ended_at) AS last_match_at
  FROM matches m
  JOIN match_players mp ON mp.match_id = m.id
  JOIN (
    SELECT match_id, COUNT(*) AS player_count
    FROM match_players
    GROUP BY match_id
  ) pc ON pc.match_id = m.id
  WHERE m.status = 'completed'
    AND COALESCE(m.is_dev, false) = false
  GROUP BY mp.user_id, m.mode
)
INSERT INTO user_mode_match_stats (
  user_id, mode, games_played, wins, losses, draws, last_match_at, updated_at
)
SELECT user_id, mode, games_played, wins, losses, draws, last_match_at, NOW()
FROM corrected
ON CONFLICT (user_id, mode) DO UPDATE
SET
  games_played = EXCLUDED.games_played,
  wins         = EXCLUDED.wins,
  losses       = EXCLUDED.losses,
  draws        = EXCLUDED.draws,
  last_match_at = EXCLUDED.last_match_at,
  updated_at   = NOW();
