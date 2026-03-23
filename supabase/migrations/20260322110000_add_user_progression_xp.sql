ALTER TABLE users
ADD COLUMN total_xp BIGINT NOT NULL DEFAULT 0
CHECK (total_xp >= 0);

CREATE TABLE IF NOT EXISTS user_xp_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('daily_challenge_completion', 'match_result')),
  source_key TEXT NOT NULL,
  xp_delta INTEGER NOT NULL CHECK (xp_delta >= 0),
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_xp_events_user_source_unique UNIQUE (user_id, source_type, source_key)
);

CREATE INDEX IF NOT EXISTS user_xp_events_user_id_idx
  ON user_xp_events(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS user_xp_events_source_idx
  ON user_xp_events(source_type, source_key);

UPDATE daily_challenge_configs
SET xp_reward = 140;
