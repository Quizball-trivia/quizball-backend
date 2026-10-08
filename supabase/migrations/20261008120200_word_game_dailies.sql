-- The solo dailies of the two word games, on the daily-game kit (like Último en pie): "played for both" (ten club
-- pairs a day, score = pairs found) and the name chain (three chains a day, score = footballers named). Day content
-- is private and names the footballer release it was built for; every run, a member's or a guest session's, is a
-- row in the game's runs table. New, empty tables: the plain index builds block nothing.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.shared_player_days (
  day date PRIMARY KEY,
  number integer NOT NULL,
  -- A hash of the stored content (up to 2^32), wider than int4: any content change is a new version.
  content_version bigint NOT NULL,
  -- Server-only: {release, pairs: [{id, release, a, b, accepted: [footballer id…], examples}] x10}.
  pairs jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_shared_player_days_number CHECK (number > 0),
  CONSTRAINT chk_shared_player_days_content_version CHECK (content_version > 0),
  CONSTRAINT chk_shared_player_days_pairs CHECK (jsonb_typeof(pairs) = 'object')
);

CREATE TABLE IF NOT EXISTS public.name_chain_days (
  day date PRIMARY KEY,
  number integer NOT NULL,
  content_version bigint NOT NULL,
  -- Server-only: {release, seed}; every start name of the day follows from them.
  chain jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_name_chain_days_number CHECK (number > 0),
  CONSTRAINT chk_name_chain_days_content_version CHECK (content_version > 0),
  CONSTRAINT chk_name_chain_days_chain CHECK (jsonb_typeof(chain) = 'object')
);

-- A run belongs to a member (user_id) or to a guest session (guest_id), never both; guest runs go with their
-- session when the guest sweeper retires it.
CREATE TABLE IF NOT EXISTS public.shared_player_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  guest_id uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
  day date NOT NULL,
  ranked boolean NOT NULL DEFAULT false,
  content_version bigint NOT NULL,
  state jsonb NOT NULL,
  state_version integer NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false,
  score integer,
  -- Tenths of a second left on the clock over the pairs found (the board's tie-break: faster ranks higher).
  speed integer,
  completed_at timestamptz,
  -- Buenos Aires midnight ending `day`: ranked writes are fenced against the database clock at this instant.
  closes_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_shared_player_runs_user_day UNIQUE (user_id, day),
  CONSTRAINT chk_shared_player_runs_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
  CONSTRAINT chk_shared_player_runs_ranked_member CHECK (NOT ranked OR user_id IS NOT NULL),
  CONSTRAINT chk_shared_player_runs_content_version CHECK (content_version > 0),
  CONSTRAINT chk_shared_player_runs_state_version CHECK (state_version >= 0),
  -- Ten pairs a day, one point each.
  CONSTRAINT chk_shared_player_runs_score CHECK (score BETWEEN 0 AND 10),
  CONSTRAINT chk_shared_player_runs_speed CHECK (speed BETWEEN 0 AND 1000),
  CONSTRAINT chk_shared_player_runs_done CHECK (done = (completed_at IS NOT NULL)),
  CONSTRAINT chk_shared_player_runs_done_result CHECK (NOT done OR (score IS NOT NULL AND speed IS NOT NULL)),
  CONSTRAINT chk_shared_player_runs_closes_at CHECK (closes_at > day::timestamp AT TIME ZONE 'UTC')
);

-- One run per player per day: the unique constraint binds members (NULL user_ids are distinct); guest runs get the
-- same rule. The index also serves the guest_sessions ON DELETE CASCADE lookup.
CREATE UNIQUE INDEX IF NOT EXISTS uq_shared_player_runs_guest_day ON public.shared_player_runs (guest_id, day) WHERE guest_id IS NOT NULL;
-- The board reads ranked, finished runs only, best first (score, then the board's second column, then who finished first).
CREATE INDEX IF NOT EXISTS idx_shared_player_runs_leaderboard ON public.shared_player_runs (day, score DESC NULLS LAST, speed DESC NULLS LAST, completed_at) WHERE ranked AND done;
-- The settle sweep: only runs whose clock is open, by its deadline (ms). A run a player walked away from between
-- two pairs stays unfinished for good and is not in it.
CREATE INDEX IF NOT EXISTS idx_shared_player_runs_open_clock ON public.shared_player_runs (((state->>'dl')::float8)) WHERE NOT done AND state->>'open' = 'true';

-- A run belongs to a member (user_id) or to a guest session (guest_id), never both; guest runs go with their
-- session when the guest sweeper retires it.
CREATE TABLE IF NOT EXISTS public.name_chain_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  guest_id uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
  day date NOT NULL,
  ranked boolean NOT NULL DEFAULT false,
  content_version bigint NOT NULL,
  state jsonb NOT NULL,
  state_version integer NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false,
  score integer,
  -- The longest of the day's three chains (the board's second column).
  longest integer,
  completed_at timestamptz,
  -- Buenos Aires midnight ending `day`: ranked writes are fenced against the database clock at this instant.
  closes_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_name_chain_runs_user_day UNIQUE (user_id, day),
  CONSTRAINT chk_name_chain_runs_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
  CONSTRAINT chk_name_chain_runs_ranked_member CHECK (NOT ranked OR user_id IS NOT NULL),
  CONSTRAINT chk_name_chain_runs_content_version CHECK (content_version > 0),
  CONSTRAINT chk_name_chain_runs_state_version CHECK (state_version >= 0),
  -- Three chains of at most thirty footballers.
  CONSTRAINT chk_name_chain_runs_score CHECK (score BETWEEN 0 AND 90),
  CONSTRAINT chk_name_chain_runs_longest CHECK (longest BETWEEN 0 AND 30),
  CONSTRAINT chk_name_chain_runs_done CHECK (done = (completed_at IS NOT NULL)),
  CONSTRAINT chk_name_chain_runs_done_result CHECK (NOT done OR (score IS NOT NULL AND longest IS NOT NULL)),
  CONSTRAINT chk_name_chain_runs_closes_at CHECK (closes_at > day::timestamp AT TIME ZONE 'UTC')
);

-- One run per player per day: the unique constraint binds members (NULL user_ids are distinct); guest runs get the
-- same rule. The index also serves the guest_sessions ON DELETE CASCADE lookup.
CREATE UNIQUE INDEX IF NOT EXISTS uq_name_chain_runs_guest_day ON public.name_chain_runs (guest_id, day) WHERE guest_id IS NOT NULL;
-- The board reads ranked, finished runs only, best first (score, then the board's second column, then who finished first).
CREATE INDEX IF NOT EXISTS idx_name_chain_runs_leaderboard ON public.name_chain_runs (day, score DESC NULLS LAST, longest DESC NULLS LAST, completed_at) WHERE ranked AND done;
-- The settle sweep: only runs whose clock is open, by its deadline (ms). A run a player walked away from between
-- two chains stays unfinished for good and is not in it.
CREATE INDEX IF NOT EXISTS idx_name_chain_runs_open_clock ON public.name_chain_runs (((state->>'dl')::float8)) WHERE NOT done AND state->>'open' = 'true';

-- Server-only (RLS without policies, no client grants): pairs, accepted footballers and seeds must never be readable
-- through the Data API.
ALTER TABLE public.shared_player_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shared_player_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.name_chain_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.name_chain_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shared_player_days, public.shared_player_runs, public.name_chain_days, public.name_chain_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.shared_player_days, public.shared_player_runs, public.name_chain_days, public.name_chain_runs TO service_role;

DROP TRIGGER IF EXISTS set_shared_player_days_updated_at ON public.shared_player_days;
CREATE TRIGGER set_shared_player_days_updated_at
  BEFORE UPDATE ON public.shared_player_days
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_shared_player_runs_updated_at ON public.shared_player_runs;
CREATE TRIGGER set_shared_player_runs_updated_at
  BEFORE UPDATE ON public.shared_player_runs
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_name_chain_days_updated_at ON public.name_chain_days;
CREATE TRIGGER set_name_chain_days_updated_at
  BEFORE UPDATE ON public.name_chain_days
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_name_chain_runs_updated_at ON public.name_chain_runs;
CREATE TRIGGER set_name_chain_runs_updated_at
  BEFORE UPDATE ON public.name_chain_runs
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
