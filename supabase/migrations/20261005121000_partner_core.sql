-- Partner core (Freecroco, docs/FREECROCO-INTERNAL-API-V1.md): partner players and their launch sessions, the
-- games/calendar rules Freecroco edits in the CMS, the per-day play quota and the plays themselves, staff
-- memberships and an audit log. Partner players are users rows (partner_slug set) with no Supabase identity; they
-- authenticate only with the partner token. Version 20261005120000 is taken (wl_reward_frames), hence 121000.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Nullable, no default: a metadata-only change.
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS partner_slug text;

-- The role check gains 'partner_staff' (CMS staff of a partner; never a player). The wider check is added NOT VALID
-- and validated by the next migration; the old one is dropped here so staff rows can be written.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_role_v2' AND conrelid = 'public.users'::regclass) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT chk_users_role_v2 CHECK (role IN ('admin', 'user', 'partner_staff')) NOT VALID;
  END IF;
  -- A partner player is always a plain player of exactly one partner.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_users_partner_slug' AND conrelid = 'public.users'::regclass) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT chk_users_partner_slug
      CHECK (partner_slug IS NULL OR (partner_slug ~ '^[a-z][a-z0-9-]{0,31}$' AND role = 'user')) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;

-- The global 4 h ticket refill (pg_cron calls it by name) must not top up partner players or partner staff: neither
-- holds a Quizball wallet. Same body as 20260912130000 plus that exclusion; no row of either kind exists yet, so
-- there is nothing to repair. CREATE OR REPLACE keeps the service_role grant.
CREATE OR REPLACE FUNCTION public.refill_tickets_global()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  refilled_count integer := 0;
BEGIN
  UPDATE public.users
  SET tickets = tickets + 1,
      updated_at = NOW()
  WHERE tickets < 5
    AND is_ai = false
    AND is_guest = false
    AND partner_slug IS NULL
    AND role <> 'partner_staff'
    AND is_deleted = false
    AND deleted_at IS NULL
    AND pending_deletion_at IS NULL;

  GET DIAGNOSTICS refilled_count = ROW_COUNT;
  RETURN refilled_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.refill_tickets_global() FROM PUBLIC, anon, authenticated;

-- One row per (partner, environment, partner's playerId). A block can arrive before the first visit, so user_id is
-- filled on the first sessions/init.
CREATE TABLE IF NOT EXISTS public.partner_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_slug text NOT NULL,
  environment text NOT NULL,
  external_player_id text NOT NULL,
  user_id uuid UNIQUE REFERENCES public.users(id) ON DELETE SET NULL,
  display_name text,
  status text NOT NULL DEFAULT 'active',
  -- Bumped on every block/unblock, so a holder of player state can tell it is stale.
  status_version integer NOT NULL DEFAULT 0,
  -- The partner's `at` of the last block/unblock applied; an older call is ignored (contract §5.5).
  status_changed_at timestamptz,
  -- Launches issued so far; allocated under this row's lock, so it orders a player's launches exactly.
  launch_seq bigint NOT NULL DEFAULT 0,
  block_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  CONSTRAINT uq_partner_players_external UNIQUE (partner_slug, environment, external_player_id),
  CONSTRAINT chk_partner_players_environment CHECK (environment IN ('test', 'production')),
  CONSTRAINT chk_partner_players_external CHECK (length(external_player_id) BETWEEN 1 AND 64),
  CONSTRAINT chk_partner_players_status CHECK (status IN ('active', 'blocked')),
  CONSTRAINT chk_partner_players_status_version CHECK (status_version >= 0),
  CONSTRAINT chk_partner_players_display_name CHECK (display_name IS NULL OR length(display_name) <= 50),
  CONSTRAINT chk_partner_players_block_reason CHECK (block_reason IS NULL OR length(block_reason) <= 200)
);

-- One row per sessions/init (id = the sessionId Freecroco sees). Only the launch token's sha256 is stored; the init
-- response (which holds the live token) is kept sealed until the token is used or expires, so a retry of the same
-- requestId gets the same answer.
CREATE TABLE IF NOT EXISTS public.partner_sessions (
  id uuid PRIMARY KEY,
  partner_slug text NOT NULL,
  environment text NOT NULL,
  player_id uuid NOT NULL REFERENCES public.partner_players(id),
  request_id text NOT NULL,
  request_hash text NOT NULL,
  -- partner_players.launch_seq at issue: a launch opened revokes the player's earlier unopened ones.
  launch_seq bigint NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_expires_at timestamptz NOT NULL,
  sealed_response text,
  state text NOT NULL DEFAULT 'issued',
  channel text NOT NULL,
  language text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  redeemed_at timestamptz,
  -- Absolute end of the gameplay session (redeem + 12 h); no refresh extends it.
  session_expires_at timestamptz,
  ended_at timestamptz,
  -- Why it ended: 'replaced' (a newer launch, contract §5.3), 'blocked', 'expired'.
  end_reason text,
  last_seen_at timestamptz,
  CONSTRAINT uq_partner_sessions_request UNIQUE (partner_slug, environment, request_id),
  CONSTRAINT uq_partner_sessions_launch UNIQUE (player_id, launch_seq),
  CONSTRAINT chk_partner_sessions_environment CHECK (environment IN ('test', 'production')),
  CONSTRAINT chk_partner_sessions_request_id CHECK (length(request_id) BETWEEN 1 AND 64),
  CONSTRAINT chk_partner_sessions_state CHECK (state IN ('issued', 'redeemed', 'revoked', 'expired')),
  CONSTRAINT chk_partner_sessions_channel CHECK (channel IN ('WEB', 'MOBILE')),
  CONSTRAINT chk_partner_sessions_language CHECK (language IN ('ka', 'en', 'ru')),
  CONSTRAINT chk_partner_sessions_redeemed CHECK ((redeemed_at IS NULL) = (session_expires_at IS NULL)),
  CONSTRAINT chk_partner_sessions_ended CHECK ((state IN ('revoked', 'expired')) = (ended_at IS NOT NULL)),
  CONSTRAINT chk_partner_sessions_end_reason CHECK (end_reason IS NULL OR end_reason IN ('replaced', 'blocked', 'expired'))
);
-- A new launch or a block revokes the player's open sessions.
CREATE INDEX IF NOT EXISTS idx_partner_sessions_player_open
  ON public.partner_sessions (player_id)
  WHERE state IN ('issued', 'redeemed');

-- Rules Freecroco edits: one row per game, plus version counters for compare-and-set saves.
CREATE TABLE IF NOT EXISTS public.partner_config_versions (
  partner_slug text NOT NULL,
  environment text NOT NULL,
  games_version integer NOT NULL DEFAULT 1,
  calendar_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_slug, environment),
  CONSTRAINT chk_partner_config_versions_environment CHECK (environment IN ('test', 'production')),
  CONSTRAINT chk_partner_config_versions_positive CHECK (games_version > 0 AND calendar_version > 0)
);

CREATE TABLE IF NOT EXISTS public.partner_games (
  partner_slug text NOT NULL,
  environment text NOT NULL,
  game_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL,
  default_limit integer NOT NULL,
  -- Set by Quizball ops when the game's partner build ships; never by the partner.
  ready boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_slug, environment, game_id),
  -- Deferred: a reorder swaps positions inside one transaction.
  CONSTRAINT uq_partner_games_order UNIQUE (partner_slug, environment, sort_order) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (partner_slug, environment) REFERENCES public.partner_config_versions (partner_slug, environment),
  CONSTRAINT chk_partner_games_game CHECK (game_id IN ('ranked', 'countdown', 'true-false', 'pick-em', 'career-path',
    'higher-lower', 'card-detective', 'guess-the-goal', 'road-to-goal', 'trivia-mines', 'quiz-board')),
  CONSTRAINT chk_partner_games_order CHECK (sort_order >= 1),
  CONSTRAINT chk_partner_games_limit CHECK (default_limit BETWEEN 0 AND CASE WHEN game_id = 'ranked' THEN 30 ELSE 10 END)
);

-- Per-day limits that beat the default (0 = off that day).
CREATE TABLE IF NOT EXISTS public.partner_limit_overrides (
  partner_slug text NOT NULL,
  environment text NOT NULL,
  date date NOT NULL,
  game_id text NOT NULL,
  plays_limit integer NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  PRIMARY KEY (partner_slug, environment, date, game_id),
  FOREIGN KEY (partner_slug, environment, game_id) REFERENCES public.partner_games (partner_slug, environment, game_id),
  CONSTRAINT chk_partner_limit_overrides_limit
    CHECK (plays_limit BETWEEN 0 AND CASE WHEN game_id = 'ranked' THEN 30 ELSE 10 END)
);

-- Every rule change, block and unblock: who, what, before and after.
CREATE TABLE IF NOT EXISTS public.partner_audit (
  id bigserial PRIMARY KEY,
  partner_slug text NOT NULL,
  environment text NOT NULL,
  -- 'user:<uuid>' for CMS staff and admins, 'partner:<slug>' for the partner's server.
  actor text NOT NULL,
  action text NOT NULL,
  target text,
  before jsonb,
  after jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_partner_audit_recent ON public.partner_audit (partner_slug, environment, at DESC);

-- The quota counter, one row per player, game and partner day (Asia/Tbilisi), locked while a play is reserved.
CREATE TABLE IF NOT EXISTS public.partner_quota_days (
  partner_slug text NOT NULL,
  environment text NOT NULL,
  player_id uuid NOT NULL REFERENCES public.partner_players(id),
  game_id text NOT NULL,
  partner_day date NOT NULL,
  plays_used integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_slug, environment, player_id, game_id, partner_day),
  CONSTRAINT chk_partner_quota_days_used CHECK (plays_used >= 0)
);

-- One row per play (id = playId). The partner day and the limit are pinned when it starts; source_ref is the game's
-- own id for the play (match participant, run id...), so a retried start never reserves twice.
CREATE TABLE IF NOT EXISTS public.partner_plays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_slug text NOT NULL,
  environment text NOT NULL,
  player_id uuid NOT NULL REFERENCES public.partner_players(id),
  session_id uuid NOT NULL REFERENCES public.partner_sessions(id),
  game_id text NOT NULL,
  partner_day date NOT NULL,
  state text NOT NULL DEFAULT 'started',
  score integer,
  limit_snapshot integer NOT NULL,
  source_ref text NOT NULL,
  refunded boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  cancelled_at timestamptz,
  CONSTRAINT uq_partner_plays_source UNIQUE (partner_slug, environment, game_id, source_ref),
  CONSTRAINT chk_partner_plays_state CHECK (state IN ('started', 'finished', 'cancelled')),
  CONSTRAINT chk_partner_plays_score CHECK (score IS NULL OR score >= 0),
  CONSTRAINT chk_partner_plays_finished CHECK ((state = 'finished') = (finished_at IS NOT NULL AND score IS NOT NULL)),
  CONSTRAINT chk_partner_plays_cancelled CHECK ((state = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT chk_partner_plays_refunded CHECK (NOT refunded OR state = 'cancelled'),
  CONSTRAINT chk_partner_plays_limit CHECK (limit_snapshot >= 0)
);
CREATE INDEX IF NOT EXISTS idx_partner_plays_player_recent ON public.partner_plays (player_id, started_at DESC);

-- Partner staff (users.role = 'partner_staff') and the partner they may see; editors may change the rules.
CREATE TABLE IF NOT EXISTS public.partner_operator_memberships (
  partner_slug text NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_slug, user_id),
  CONSTRAINT chk_partner_operator_memberships_role CHECK (role IN ('viewer', 'editor'))
);

-- Server-only (RLS without policies, no client grants): never reachable through the Data API.
ALTER TABLE public.partner_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_config_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_games ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_limit_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_quota_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_plays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_operator_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_players, public.partner_sessions, public.partner_config_versions, public.partner_games,
  public.partner_limit_overrides, public.partner_audit, public.partner_quota_days, public.partner_plays,
  public.partner_operator_memberships FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.partner_players, public.partner_sessions, public.partner_config_versions, public.partner_games,
  public.partner_limit_overrides, public.partner_audit, public.partner_quota_days, public.partner_plays,
  public.partner_operator_memberships TO service_role;
REVOKE ALL ON SEQUENCE public.partner_audit_id_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.partner_audit_id_seq TO service_role;

-- Default rule set (internal doc §3): all 11 games enabled and ready in Freecroco's order (they ship together), 1 play a
-- day (ranked 10). Existing rows are never touched.
INSERT INTO public.partner_config_versions (partner_slug, environment)
VALUES ('freecroco', 'test'), ('freecroco', 'production')
ON CONFLICT (partner_slug, environment) DO NOTHING;

INSERT INTO public.partner_games (partner_slug, environment, game_id, enabled, sort_order, default_limit, ready)
SELECT 'freecroco', env.environment, g.game_id, true, g.sort_order, CASE WHEN g.game_id = 'ranked' THEN 10 ELSE 1 END, true
FROM (VALUES ('test'), ('production')) AS env(environment)
CROSS JOIN (VALUES
  ('ranked', 1), ('guess-the-goal', 2), ('true-false', 3), ('countdown', 4), ('pick-em', 5), ('career-path', 6),
  ('higher-lower', 7), ('card-detective', 8), ('road-to-goal', 9), ('trivia-mines', 10), ('quiz-board', 11)
) AS g(game_id, sort_order)
ON CONFLICT (partner_slug, environment, game_id) DO NOTHING;
