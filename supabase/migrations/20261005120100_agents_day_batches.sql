-- Day batches: the agents pipeline (VPS) builds the next days of a daily game as ONE batch. The backend appends a
-- validated batch to the game's days table in the same transaction that marks it seeded: automatically, or after a
-- person approves it in the CMS for a game on hold. The VPS never writes a game's days table. Answers live in `days`
-- (server-side files), so the tables are server-only.
-- Additive, no locks on existing tables.
SET LOCAL lock_timeout = '5s';

CREATE SCHEMA IF NOT EXISTS agents;

CREATE TABLE IF NOT EXISTS agents.day_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- one batch per job: a restarted job finds its batch instead of building another
  job_id uuid NOT NULL UNIQUE,
  game text NOT NULL,
  first_day date NOT NULL,
  last_day date NOT NULL,
  -- the full server-side day files, as the game's seed CLI reads them
  days jsonb NOT NULL,
  -- what the builder needs to schedule the next batch (e.g. Buscaminas per-round category keys)
  evidence jsonb,
  -- the validator's verdict and output, with the builder/validator versions; only ok batches can be approved
  validation jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  plan jsonb,
  error text,
  reject_reason text,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_day_batches_game CHECK (game IN ('buscaminas', 'pistas', 'ultimo', 'minuto')),
  CONSTRAINT chk_day_batches_status CHECK (status IN ('pending', 'seeded', 'rejected', 'failed')),
  CONSTRAINT chk_day_batches_range CHECK (last_day >= first_day),
  CONSTRAINT chk_day_batches_decided CHECK ((status IN ('seeded', 'rejected')) = (decided_at IS NOT NULL))
);

-- one open batch per game: two batches for the same dates could never both be appended
CREATE UNIQUE INDEX IF NOT EXISTS uq_day_batches_pending_game ON agents.day_batches (game) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_day_batches_game_created ON agents.day_batches (game, created_at DESC);

-- Per game: whether a validated batch waits for a person (hold_for_review) or is appended automatically. A batch that
-- failed validation always waits; one the append refuses (the calendar changed since validation) is marked failed.
CREATE TABLE IF NOT EXISTS agents.daily_game_settings (
  game text PRIMARY KEY,
  hold_for_review boolean NOT NULL DEFAULT false,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_daily_game_settings_game CHECK (game IN ('buscaminas', 'pistas', 'ultimo', 'minuto'))
);

ALTER TABLE agents.day_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents.daily_game_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON agents.day_batches, agents.daily_game_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON agents.day_batches, agents.daily_game_settings TO service_role;
