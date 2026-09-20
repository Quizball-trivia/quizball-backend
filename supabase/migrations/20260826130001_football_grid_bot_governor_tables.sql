-- New governor tables are isolated from the hot match-column ALTER so that its
-- ACCESS EXCLUSIVE lock is released before this longer transactional work.

CREATE TABLE IF NOT EXISTS public.football_grid_bot_governor_state (
  bot_model_version integer NOT NULL CHECK (bot_model_version > 0),
  bot_config_version integer NOT NULL CHECK (bot_config_version > 0),
  bot_tier text NOT NULL CHECK (
    bot_tier IN (
      'Academy', 'Youth Prospect', 'Reserve', 'Bench', 'Rotation',
      'Starting11', 'Key Player', 'Captain', 'World-Class', 'Legend', 'GOAT'
    )
  ),
  strength_adjustment numeric(6,4) NOT NULL DEFAULT 0
    CHECK (strength_adjustment BETWEEN -0.2000 AND 0.0000),
  score_ema numeric(7,6) CHECK (score_ema IS NULL OR score_ema BETWEEN 0 AND 1),
  observation_count integer NOT NULL DEFAULT 0 CHECK (observation_count >= 0),
  observations_at_adjustment integer NOT NULL DEFAULT 0
    CHECK (observations_at_adjustment >= 0),
  adjustment_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_model_version, bot_config_version, bot_tier),
  CHECK (observations_at_adjustment <= observation_count)
);

CREATE TABLE IF NOT EXISTS public.football_grid_bot_governor_observations (
  match_id uuid PRIMARY KEY
    REFERENCES public.football_grid_matches(match_id) ON DELETE CASCADE,
  bot_model_version integer NOT NULL CHECK (bot_model_version > 0),
  bot_config_version integer NOT NULL CHECK (bot_config_version > 0),
  bot_tier text NOT NULL CHECK (
    bot_tier IN (
      'Academy', 'Youth Prospect', 'Reserve', 'Bench', 'Rotation',
      'Starting11', 'Key Player', 'Captain', 'World-Class', 'Legend', 'GOAT'
    )
  ),
  pinned_strength_adjustment numeric(6,4) NOT NULL
    CHECK (pinned_strength_adjustment BETWEEN -0.2000 AND 0.0000),
  outcome_score numeric(2,1) NOT NULL CHECK (outcome_score IN (0.0, 0.5, 1.0)),
  completion_reason text NOT NULL CHECK (
    completion_reason IN ('line', 'board_full', 'turn_limit')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (bot_model_version, bot_config_version, bot_tier)
    REFERENCES public.football_grid_bot_governor_state (
      bot_model_version, bot_config_version, bot_tier
    )
);

-- Detailed policy inputs stay server-only. They are deliberately not written
-- into football_grid_events, which may be replayed or delivered to clients.
CREATE TABLE IF NOT EXISTS public.football_grid_bot_action_audits (
  match_id uuid NOT NULL
    REFERENCES public.football_grid_matches(match_id) ON DELETE CASCADE,
  turn_number integer NOT NULL CHECK (turn_number >= 0),
  bot_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  cell_index smallint NOT NULL CHECK (cell_index BETWEEN 0 AND 8),
  outcome text NOT NULL CHECK (outcome IN ('correct', 'wrong', 'pass')),
  bot_model_version integer NOT NULL CHECK (bot_model_version > 0),
  bot_config_version integer NOT NULL CHECK (bot_config_version > 0),
  bot_tier text NOT NULL CHECK (
    bot_tier IN (
      'Academy', 'Youth Prospect', 'Reserve', 'Bench', 'Rotation',
      'Starting11', 'Key Player', 'Captain', 'World-Class', 'Legend', 'GOAT'
    )
  ),
  base_accuracy numeric(7,6) NOT NULL CHECK (base_accuracy BETWEEN 0 AND 1),
  scarcity_multiplier numeric(7,6) NOT NULL CHECK (scarcity_multiplier BETWEEN 0 AND 1),
  effective_accuracy numeric(7,6) NOT NULL CHECK (effective_accuracy BETWEEN 0 AND 1),
  tactical_optimality numeric(7,6) NOT NULL CHECK (tactical_optimality BETWEEN 0 AND 1),
  pass_on_miss numeric(7,6) NOT NULL CHECK (pass_on_miss BETWEEN 0 AND 1),
  candidate_count integer NOT NULL CHECK (candidate_count >= 0),
  recognizable_pool_size integer NOT NULL CHECK (
    recognizable_pool_size BETWEEN 0 AND 5
    AND recognizable_pool_size <= candidate_count
  ),
  pinned_strength_adjustment numeric(6,4) NOT NULL
    CHECK (pinned_strength_adjustment BETWEEN -0.2000 AND 0.0000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, turn_number),
  FOREIGN KEY (bot_model_version, bot_config_version, bot_tier)
    REFERENCES public.football_grid_bot_governor_state (
      bot_model_version, bot_config_version, bot_tier
    )
);

CREATE INDEX IF NOT EXISTS football_grid_bot_action_audits_policy_idx
  ON public.football_grid_bot_action_audits (
    bot_model_version, bot_config_version, bot_tier, created_at DESC
  );

ALTER TABLE public.football_grid_bot_governor_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_bot_governor_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_bot_action_audits ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.football_grid_bot_governor_state
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.football_grid_bot_governor_observations
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.football_grid_bot_action_audits
  FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.football_grid_bot_governor_state IS
  'Tier-level Football Tic Tac Toe safety governor; independent from Ranked bot state.';
COMMENT ON TABLE public.football_grid_bot_governor_observations IS
  'Idempotent competitive bot-v-human outcome observations folded asynchronously after settlement.';
COMMENT ON TABLE public.football_grid_bot_action_audits IS
  'Server-only per-turn policy provenance used to verify bot difficulty and answer familiarity.';
