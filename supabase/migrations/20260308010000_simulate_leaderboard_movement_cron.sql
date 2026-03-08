-- Function: simulate_leaderboard_movement()
-- Randomly adjusts RP by -40 to +40 for fake users to keep the leaderboard alive.
-- Only affects fake users (no user_identities row, not AI, already placed).
-- Real users always have a user_identities row so they are never touched.

CREATE OR REPLACE FUNCTION simulate_leaderboard_movement()
RETURNS void AS $$
  WITH fake_profiles AS (
    SELECT rp.user_id, rp.rp AS old_rp
    FROM ranked_profiles rp
    JOIN users u ON u.id = rp.user_id
    LEFT JOIN user_identities ui ON ui.user_id = u.id
    WHERE u.is_ai = false
      AND ui.id IS NULL
      AND rp.placement_status = 'placed'
  ),
  new_rp AS (
    SELECT user_id,
      GREATEST(0, old_rp + (floor(random() * 81) - 40)::int) AS rp
    FROM fake_profiles
  )
  UPDATE ranked_profiles rp
  SET
    rp = nr.rp,
    tier = CASE
      WHEN nr.rp >= 3200 THEN 'GOAT'
      WHEN nr.rp >= 2900 THEN 'Legend'
      WHEN nr.rp >= 2600 THEN 'World-Class'
      WHEN nr.rp >= 2200 THEN 'Captain'
      WHEN nr.rp >= 1850 THEN 'Key Player'
      WHEN nr.rp >= 1500 THEN 'Starting11'
      WHEN nr.rp >= 1200 THEN 'Rotation'
      WHEN nr.rp >= 900  THEN 'Bench'
      WHEN nr.rp >= 600  THEN 'Reserve'
      WHEN nr.rp >= 300  THEN 'Youth Prospect'
      ELSE 'Academy'
    END,
    last_ranked_match_at = NOW() - (random() * interval '1 hour'),
    updated_at = NOW()
  FROM new_rp nr
  WHERE rp.user_id = nr.user_id;
$$ LANGUAGE sql;

-- Unschedule existing job if any (idempotent)
SELECT cron.unschedule('simulate-leaderboard-movement') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'simulate-leaderboard-movement'
);

-- Run every 4 hours
SELECT cron.schedule(
  'simulate-leaderboard-movement',
  '0 */4 * * *',
  'SELECT simulate_leaderboard_movement()'
);
