-- Keep Countdown available as a Daily Challenges hub card after removing it
-- from ranked possession normal play. Existing rewards/settings/order are
-- intentionally preserved; defaults are only used if the config row is absent.

INSERT INTO daily_challenge_configs (
  challenge_type,
  is_active,
  sort_order,
  show_on_home,
  coin_reward,
  xp_reward,
  settings
)
VALUES (
  'countdown',
  true,
  4,
  false,
  350,
  100,
  jsonb_build_object(
    'categoryIds', jsonb_build_array(),
    'roundCount', 2,
    'secondsPerRound', 30
  )
)
ON CONFLICT (challenge_type)
DO UPDATE SET
  is_active = true,
  show_on_home = false,
  updated_at = NOW();
