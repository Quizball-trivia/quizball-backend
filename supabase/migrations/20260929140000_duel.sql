-- Friend duels for the daily mini-games (Buscaminas, Pistas): a friend room in game mode 'duel' starts a
-- duel_matches row; the engine state lives on it, the content pack (answers included) in duel_match_content.
-- Duel content comes only from duel_pool, which is disjoint from every daily by seed validation.
-- All tables are new and empty here, so the plain index builds block nothing; the lobbies constraint is
-- added NOT VALID and validated by the next migration.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.lobbies ADD COLUMN IF NOT EXISTS duel_game text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c WHERE c.conname = 'lobbies_game_mode_check_v3' AND c.conrelid = 'public.lobbies'::regclass
  ) THEN
    ALTER TABLE public.lobbies
      ADD CONSTRAINT lobbies_game_mode_check_v3 CHECK (
        game_mode IN ('friendly_possession', 'friendly_party_quiz', 'auction', 'ranked_sim', 'football_grid', 'duel')
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c WHERE c.conname = 'lobbies_duel_game_check' AND c.conrelid = 'public.lobbies'::regclass
  ) THEN
    -- A duel room always names its game; no other room has one. Written NULL-safe: a CHECK that evaluates to
    -- NULL passes, so plain `=`/`IN` would let a duel room without a game (or a NULL mode with one) through.
    ALTER TABLE public.lobbies
      ADD CONSTRAINT lobbies_duel_game_check CHECK (
        (game_mode IS DISTINCT FROM 'duel' AND duel_game IS NULL)
        OR (game_mode IS NOT DISTINCT FROM 'duel' AND duel_game IS NOT NULL AND duel_game IN ('buscaminas', 'pistas'))
      ) NOT VALID;
  END IF;
END $$;

-- Private duel-only content: one row per playable item (a Buscaminas round, a Pistas player).
CREATE TABLE IF NOT EXISTS public.duel_pool (
  game text NOT NULL,
  item_id text NOT NULL,
  difficulty text NOT NULL,
  -- Identity used to keep the pool disjoint from the dailies (normalised answer / category key + cards).
  fingerprint text NOT NULL,
  payload jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game, item_id),
  CONSTRAINT chk_duel_pool_game CHECK (game IN ('buscaminas', 'pistas')),
  CONSTRAINT chk_duel_pool_difficulty CHECK (difficulty IN ('easy', 'medium', 'hard')),
  CONSTRAINT chk_duel_pool_payload CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_duel_pool_pick ON public.duel_pool (game, difficulty) WHERE enabled;

CREATE TABLE IF NOT EXISTS public.duel_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game text NOT NULL,
  engine_version integer NOT NULL,
  lobby_id uuid REFERENCES public.lobbies(id) ON DELETE SET NULL,
  status text NOT NULL,
  state jsonb,
  state_version integer NOT NULL DEFAULT 0,
  -- Bumped whenever the deadline changes: a timer carrying an older token does nothing.
  phase_token integer NOT NULL DEFAULT 0,
  phase_deadline_at timestamptz,
  rng_counter integer NOT NULL DEFAULT 0,
  -- While paused (a seat disconnected): the status to resume to and the phase time that was left.
  paused_from text,
  paused_remaining_ms integer,
  -- {scores:[a,b], winnerSeat:0|1|null, reason:'score'|'forfeit'|'idle'|'cancelled', forfeitSeat}
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  CONSTRAINT chk_duel_matches_game CHECK (game IN ('buscaminas', 'pistas')),
  CONSTRAINT chk_duel_matches_status CHECK (status IN ('ready', 'countdown', 'active', 'paused', 'completed', 'cancelled')),
  CONSTRAINT chk_duel_matches_pause CHECK (
    (status = 'paused') = (paused_from IS NOT NULL AND paused_remaining_ms IS NOT NULL)
    AND (paused_from IS NULL OR paused_from IN ('countdown', 'active'))
  ),
  -- A live match always has a clock: nothing ever waits forever.
  CONSTRAINT chk_duel_matches_deadline CHECK (status IN ('completed', 'cancelled') OR phase_deadline_at IS NOT NULL),
  CONSTRAINT chk_duel_matches_result CHECK ((status IN ('completed', 'cancelled')) = (result IS NOT NULL)),
  CONSTRAINT chk_duel_matches_active_state CHECK (status <> 'active' OR state IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_duel_matches_due ON public.duel_matches (phase_deadline_at) WHERE status IN ('ready', 'countdown', 'active', 'paused');
-- The lobby FK's ON DELETE lookup (any lobby delete) and retention both scan history: index them.
CREATE INDEX IF NOT EXISTS idx_duel_matches_lobby ON public.duel_matches (lobby_id);
CREATE INDEX IF NOT EXISTS idx_duel_matches_ended ON public.duel_matches (ended_at) WHERE ended_at IS NOT NULL;
-- One live duel per room.
CREATE UNIQUE INDEX IF NOT EXISTS uq_duel_matches_live_lobby ON public.duel_matches (lobby_id) WHERE status IN ('ready', 'countdown', 'active', 'paused');

-- Written once when the match is created; never on the row every command locks.
CREATE TABLE IF NOT EXISTS public.duel_match_content (
  match_id uuid PRIMARY KEY REFERENCES public.duel_matches(id) ON DELETE CASCADE,
  seed text NOT NULL,
  item_ids text[] NOT NULL,
  content jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS public.duel_participants (
  match_id uuid NOT NULL REFERENCES public.duel_matches(id) ON DELETE CASCADE,
  seat smallint NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  is_guest boolean NOT NULL DEFAULT false,
  locale text NOT NULL DEFAULT 'es',
  ready_at timestamptz,
  -- Presence: a seat with no socket left (after a short debounce) is absent; its absence is charged to a
  -- per-match budget, and a pause that outlives the budget (or the per-episode cap) forfeits the seat.
  connected boolean NOT NULL DEFAULT true,
  absent_since timestamptz,
  -- This seat's own reconnect deadline while it is away (two seats away have two deadlines).
  absence_deadline_at timestamptz,
  absence_budget_ms integer NOT NULL DEFAULT 60000,
  -- Bumped on every (re)connect: a disconnect check that read an older value is stale and does nothing.
  presence_gen integer NOT NULL DEFAULT 0,
  score integer,
  outcome text,
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (match_id, seat),
  CONSTRAINT uq_duel_participants_user UNIQUE (match_id, user_id),
  CONSTRAINT chk_duel_participants_seat CHECK (seat IN (0, 1)),
  CONSTRAINT chk_duel_participants_locale CHECK (locale IN ('es', 'en', 'ka', 'tr')),
  CONSTRAINT chk_duel_participants_outcome CHECK (outcome IS NULL OR outcome IN ('win', 'loss', 'draw', 'cancelled'))
);
-- The database itself refuses a second live duel for the same person.
CREATE UNIQUE INDEX IF NOT EXISTS uq_duel_participants_one_live ON public.duel_participants (user_id) WHERE active;
CREATE INDEX IF NOT EXISTS idx_duel_participants_user ON public.duel_participants (user_id, match_id);

-- Idempotent inbox: a retried command returns its stored result; the same id with other content is refused.
CREATE TABLE IF NOT EXISTS public.duel_commands (
  match_id uuid NOT NULL REFERENCES public.duel_matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  command_id uuid NOT NULL,
  payload_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id, command_id)
);

ALTER TABLE public.duel_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.duel_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.duel_match_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.duel_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.duel_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.duel_pool, public.duel_matches, public.duel_match_content, public.duel_participants, public.duel_commands
  FROM PUBLIC, anon, authenticated;
