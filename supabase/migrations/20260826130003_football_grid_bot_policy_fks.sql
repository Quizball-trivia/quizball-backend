-- The online unique index is now present. NOT VALID avoids scanning the child
-- tables while immediately enforcing the immutable match-policy relationship
-- for every new observation and action.
DO $$
BEGIN
  ALTER TABLE public.football_grid_bot_governor_observations
    ADD CONSTRAINT football_grid_bot_governor_observations_match_policy_fk
    FOREIGN KEY (
      match_id, bot_model_version, bot_config_version, bot_tier,
      pinned_strength_adjustment
    ) REFERENCES public.football_grid_matches (
      match_id, bot_model_version, bot_config_version, bot_tier,
      bot_strength_adjustment
    ) NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  ALTER TABLE public.football_grid_bot_action_audits
    ADD CONSTRAINT football_grid_bot_action_audits_match_policy_fk
    FOREIGN KEY (
      match_id, bot_model_version, bot_config_version, bot_tier,
      pinned_strength_adjustment
    ) REFERENCES public.football_grid_matches (
      match_id, bot_model_version, bot_config_version, bot_tier,
      bot_strength_adjustment
    ) NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
