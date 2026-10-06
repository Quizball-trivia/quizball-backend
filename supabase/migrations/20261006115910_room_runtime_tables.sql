-- Room games, part 2 of 3: the match tables. The engine state lives on the match row, the questions (values
-- included) in room_match_content; content comes only from the private room_pool. New, empty tables: plain index
-- builds block nothing. The lobbies foreign key takes only a brief SHARE ROW EXCLUSIVE lock on lobbies.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Private room-only content: disjoint from every public question by seed validation.
CREATE TABLE IF NOT EXISTS public.room_pool (
  game text NOT NULL,
  item_id text NOT NULL,
  difficulty text NOT NULL,
  fingerprint text NOT NULL,
  payload jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game, item_id),
  CONSTRAINT chk_room_pool_game CHECK (game IN ('aproximado')),
  CONSTRAINT chk_room_pool_difficulty CHECK (difficulty IN ('easy', 'medium', 'hard')),
  CONSTRAINT chk_room_pool_payload CHECK (jsonb_typeof(payload) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_room_pool_pick ON public.room_pool (game, difficulty) WHERE enabled;
CREATE UNIQUE INDEX IF NOT EXISTS uq_room_pool_fingerprint ON public.room_pool (game, fingerprint);

CREATE TABLE IF NOT EXISTS public.room_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game text NOT NULL,
  engine_version integer NOT NULL,
  lobby_id uuid REFERENCES public.lobbies(id) ON DELETE SET NULL,
  status text NOT NULL,
  -- The engine state (phase, round, its own deadline in epoch ms, guesses, results, seat statuses).
  state jsonb,
  state_version integer NOT NULL DEFAULT 0,
  -- Bumped whenever the match deadline changes: a timer carrying an older token does nothing.
  phase_token integer NOT NULL DEFAULT 0,
  -- The earliest of the engine deadline and every away seat's absence deadline.
  phase_deadline_at timestamptz,
  -- {standings:[{seat,userId,points,roundWins,place,withdrawn}], reason:'score'|'cancelled'}
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  CONSTRAINT chk_room_matches_game CHECK (game IN ('aproximado')),
  CONSTRAINT chk_room_matches_status CHECK (status IN ('ready', 'active', 'completed', 'cancelled')),
  -- A live match always has a clock: nothing ever waits forever.
  CONSTRAINT chk_room_matches_deadline CHECK (status IN ('completed', 'cancelled') OR phase_deadline_at IS NOT NULL),
  CONSTRAINT chk_room_matches_result CHECK ((status IN ('completed', 'cancelled')) = (result IS NOT NULL)),
  CONSTRAINT chk_room_matches_active_state CHECK (status <> 'active' OR state IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_room_matches_due ON public.room_matches (phase_deadline_at) WHERE status IN ('ready', 'active');
CREATE INDEX IF NOT EXISTS idx_room_matches_lobby ON public.room_matches (lobby_id);
CREATE INDEX IF NOT EXISTS idx_room_matches_ended ON public.room_matches (ended_at) WHERE ended_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_room_matches_live_lobby ON public.room_matches (lobby_id) WHERE status IN ('ready', 'active');

-- Written once when the match is created; never on the row every command locks.
CREATE TABLE IF NOT EXISTS public.room_match_content (
  match_id uuid PRIMARY KEY REFERENCES public.room_matches(id) ON DELETE CASCADE,
  item_ids text[] NOT NULL,
  content jsonb NOT NULL
);

ALTER TABLE public.room_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_match_content ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.room_pool, public.room_matches, public.room_match_content FROM PUBLIC, anon, authenticated;
