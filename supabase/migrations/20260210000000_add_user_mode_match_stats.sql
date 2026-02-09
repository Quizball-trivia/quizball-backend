CREATE TABLE user_mode_match_stats (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('ranked', 'friendly')),
  games_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  last_match_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, mode),
  CHECK (games_played >= 0 AND wins >= 0 AND losses >= 0 AND draws >= 0)
);

CREATE INDEX IF NOT EXISTS idx_user_mode_match_stats_user_id
  ON user_mode_match_stats (user_id);

WITH completed_match_rows AS (
  SELECT
    mp.user_id,
    m.mode,
    COUNT(*)::int AS games_played,
    COUNT(*) FILTER (WHERE m.winner_user_id = mp.user_id)::int AS wins,
    COUNT(*) FILTER (WHERE m.winner_user_id IS NOT NULL AND m.winner_user_id <> mp.user_id)::int AS losses,
    COUNT(*) FILTER (WHERE m.winner_user_id IS NULL)::int AS draws,
    MAX(m.ended_at) AS last_match_at
  FROM matches m
  JOIN match_players mp ON mp.match_id = m.id
  WHERE m.status = 'completed'
  GROUP BY mp.user_id, m.mode
)
INSERT INTO user_mode_match_stats (
  user_id,
  mode,
  games_played,
  wins,
  losses,
  draws,
  last_match_at,
  updated_at
)
SELECT
  user_id,
  mode,
  games_played,
  wins,
  losses,
  draws,
  last_match_at,
  NOW()
FROM completed_match_rows
ON CONFLICT (user_id, mode) DO UPDATE
SET
  games_played = EXCLUDED.games_played,
  wins = EXCLUDED.wins,
  losses = EXCLUDED.losses,
  draws = EXCLUDED.draws,
  last_match_at = EXCLUDED.last_match_at,
  updated_at = NOW();
