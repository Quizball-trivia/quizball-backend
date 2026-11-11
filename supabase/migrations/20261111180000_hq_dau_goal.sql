-- New North Star (owner, 2026-11-11): 5,000 daily active players. The 10,000 weekly active players goal is achieved
-- (the count is confirmed: the CMS was undercounting guest accounts before 2026-11-11).
ALTER TABLE hq.goals DROP CONSTRAINT hq_goals_metric;
ALTER TABLE hq.goals ADD CONSTRAINT hq_goals_metric
  CHECK (metric IN ('new_users', 'active_players', 'daily_active_players', 'matches', 'd7_retention', 'avg_rating'));

UPDATE hq.goals SET status = 'achieved', updated_at = now()
 WHERE horizon = 'north_star' AND status = 'active' AND metric = 'active_players' AND target = 10000;

INSERT INTO hq.goals (horizon, title, description, metric, target, period_start, period_end, status, position)
SELECT 'north_star', 'Grow to 5,000 daily active players',
       'Distinct players (registered or guest) in one Tbilisi day, on every game and daily. Measured on the last complete day.',
       'daily_active_players', 5000, DATE '2026-11-11', DATE '2027-03-31', 'active', 0
 WHERE NOT EXISTS (SELECT 1 FROM hq.goals WHERE horizon = 'north_star' AND status = 'active');
