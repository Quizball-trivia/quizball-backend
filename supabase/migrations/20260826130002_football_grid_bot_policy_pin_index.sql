-- One statement only: the migration runner detects CONCURRENTLY and executes
-- this outside a transaction with an online-DDL lock timeout.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS football_grid_matches_bot_policy_pin_uidx
  ON public.football_grid_matches (
    match_id, bot_model_version, bot_config_version, bot_tier,
    bot_strength_adjustment
  );
