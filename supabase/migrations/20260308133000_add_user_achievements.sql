CREATE TABLE IF NOT EXISTS user_achievements (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id text NOT NULL,
  progress integer NOT NULL DEFAULT 0 CHECK (progress >= 0),
  unlocked_at timestamptz NULL,
  source_match_id uuid NULL REFERENCES matches(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, achievement_id)
);

CREATE INDEX IF NOT EXISTS user_achievements_user_id_idx
  ON user_achievements (user_id);

CREATE INDEX IF NOT EXISTS user_achievements_source_match_id_idx
  ON user_achievements (source_match_id)
  WHERE source_match_id IS NOT NULL;

WITH ordered_matches AS (
  SELECT
    mp.user_id,
    m.id AS match_id,
    m.winner_user_id,
    ROW_NUMBER() OVER (
      PARTITION BY mp.user_id
      ORDER BY COALESCE(m.ended_at, m.started_at) ASC, m.id ASC
    ) AS rn
  FROM matches m
  JOIN match_players mp ON mp.match_id = m.id
  WHERE m.status = 'completed'
),
win_rows AS (
  SELECT
    user_id,
    rn - ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY rn) AS grp
  FROM ordered_matches
  WHERE winner_user_id = user_id
),
best_win_streaks AS (
  SELECT user_id, MAX(streak)::int AS best_streak
  FROM (
    SELECT user_id, grp, COUNT(*)::int AS streak
    FROM win_rows
    GROUP BY user_id, grp
  ) grouped
  GROUP BY user_id
),
metrics AS (
  SELECT
    u.id AS user_id,
    COALESCE((
      SELECT COUNT(*)::int
      FROM matches m
      JOIN match_players mp ON mp.match_id = m.id
      WHERE mp.user_id = u.id
        AND m.status = 'completed'
    ), 0) AS completed_matches,
    COALESCE((
      SELECT COUNT(*)::int
      FROM matches m
      JOIN match_players mp ON mp.match_id = m.id
      WHERE mp.user_id = u.id
        AND m.status = 'completed'
        AND m.winner_user_id = u.id
    ), 0) AS total_wins,
    COALESCE((
      SELECT COUNT(*)::int
      FROM matches m
      JOIN match_players mp ON mp.match_id = m.id
      WHERE mp.user_id = u.id
        AND m.status = 'completed'
        AND m.winner_user_id = u.id
        AND COALESCE(m.state_payload->>'variant', '') = 'friendly_party_quiz'
    ), 0) AS party_quiz_wins,
    EXISTS (
      SELECT 1
      FROM matches m
      JOIN match_players mp ON mp.match_id = m.id
      WHERE mp.user_id = u.id
        AND m.status = 'completed'
        AND mp.correct_answers >= m.total_questions
    ) AS has_perfect_match,
    EXISTS (
      SELECT 1
      FROM match_answers ma
      WHERE ma.user_id = u.id
        AND ma.is_correct = true
        AND ma.time_ms <= 2000
    ) AS has_lightning_counter,
    EXISTS (
      SELECT 1
      FROM matches m
      JOIN match_players mp_self
        ON mp_self.match_id = m.id
       AND mp_self.user_id = u.id
      WHERE m.status = 'completed'
        AND m.winner_user_id = u.id
        AND COALESCE(m.state_payload->>'variant', 'friendly_possession') <> 'friendly_party_quiz'
        AND NOT EXISTS (
          SELECT 1
          FROM match_players mp_opp
          WHERE mp_opp.match_id = m.id
            AND mp_opp.user_id <> u.id
            AND (mp_opp.goals > 0 OR mp_opp.penalty_goals > 0)
        )
    ) AS has_clean_sheet,
    COALESCE(bws.best_streak, 0) AS best_win_streak
  FROM users u
  LEFT JOIN best_win_streaks bws ON bws.user_id = u.id
),
backfill_rows AS (
  SELECT user_id, 'debut_match'::text AS achievement_id, LEAST(completed_matches, 1) AS progress, CASE WHEN completed_matches >= 1 THEN NOW() ELSE NULL END AS unlocked_at
  FROM metrics
  WHERE completed_matches > 0

  UNION ALL

  SELECT user_id, 'hat_trick_hero'::text, 1, NOW()
  FROM metrics
  WHERE has_perfect_match

  UNION ALL

  SELECT user_id, 'lightning_counter'::text, 1, NOW()
  FROM metrics
  WHERE has_lightning_counter

  UNION ALL

  SELECT user_id, 'clean_sheet'::text, 1, NOW()
  FROM metrics
  WHERE has_clean_sheet

  UNION ALL

  SELECT user_id, 'winning_streak'::text, LEAST(best_win_streak, 5), CASE WHEN best_win_streak >= 5 THEN NOW() ELSE NULL END
  FROM metrics
  WHERE best_win_streak > 0

  UNION ALL

  SELECT user_id, 'multiplayer_master'::text, LEAST(total_wins, 10), CASE WHEN total_wins >= 10 THEN NOW() ELSE NULL END
  FROM metrics
  WHERE total_wins > 0

  UNION ALL

  SELECT user_id, 'trophy_collector'::text, LEAST(party_quiz_wins, 1), CASE WHEN party_quiz_wins >= 1 THEN NOW() ELSE NULL END
  FROM metrics
  WHERE party_quiz_wins > 0
)
INSERT INTO user_achievements (
  user_id,
  achievement_id,
  progress,
  unlocked_at,
  source_match_id
)
SELECT
  user_id,
  achievement_id,
  progress,
  unlocked_at,
  NULL
FROM backfill_rows
ON CONFLICT (user_id, achievement_id)
DO UPDATE SET
  progress = EXCLUDED.progress,
  unlocked_at = COALESCE(user_achievements.unlocked_at, EXCLUDED.unlocked_at),
  updated_at = NOW();
