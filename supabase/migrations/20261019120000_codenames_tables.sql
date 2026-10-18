-- Football Codenames: picture cards (football caricatures and objects), two teams, clues. Rooms deal a random board
-- from the private card pool (room_pool, one item per card); the daily is on the daily-game kit: one day row (a
-- self-contained board: the cards, the key and the bot's clues), one run per player. Every table is private (RLS on,
-- no client grants): the key reaches a player only through the server's views.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.codenames_days (
  day date PRIMARY KEY,
  number integer NOT NULL,
  content_version bigint NOT NULL,
  -- The day's board: 20 cards with their key, the three clues (word per language, count, cards, why per language).
  board jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_codenames_days_number CHECK (number > 0),
  CONSTRAINT chk_codenames_days_content_version CHECK (content_version > 0),
  CONSTRAINT chk_codenames_days_board CHECK (jsonb_typeof(board) = 'object')
);

CREATE TABLE IF NOT EXISTS public.codenames_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  guest_id uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
  day date NOT NULL,
  ranked boolean NOT NULL DEFAULT false,
  content_version bigint NOT NULL,
  state jsonb NOT NULL,
  state_version integer NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false,
  -- Cards found × 100 + (99 − misses): one number orders the board.
  score integer,
  -- Rival, neutral and Own Goal cards flipped.
  misses integer,
  completed_at timestamptz,
  closes_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_codenames_runs_user_day UNIQUE (user_id, day),
  CONSTRAINT chk_codenames_runs_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
  CONSTRAINT chk_codenames_runs_ranked_member CHECK (NOT ranked OR user_id IS NOT NULL),
  CONSTRAINT chk_codenames_runs_content_version CHECK (content_version > 0),
  CONSTRAINT chk_codenames_runs_state_version CHECK (state_version >= 0),
  CONSTRAINT chk_codenames_runs_score CHECK (score BETWEEN 0 AND 1000),
  CONSTRAINT chk_codenames_runs_misses CHECK (misses BETWEEN 0 AND 20),
  CONSTRAINT chk_codenames_runs_done CHECK (done = (completed_at IS NOT NULL)),
  CONSTRAINT chk_codenames_runs_done_result CHECK (NOT done OR (score IS NOT NULL AND misses IS NOT NULL)),
  CONSTRAINT chk_codenames_runs_closes_at CHECK (closes_at > day::timestamp AT TIME ZONE 'UTC')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_codenames_runs_guest_day
  ON public.codenames_runs (guest_id, day)
  WHERE guest_id IS NOT NULL;

-- Board order: score (fewer misses already counted in it), then the earlier finish.
CREATE INDEX IF NOT EXISTS idx_codenames_runs_leaderboard
  ON public.codenames_runs (day, score DESC NULLS LAST, completed_at)
  WHERE ranked AND done;

ALTER TABLE public.codenames_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.codenames_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.codenames_days, public.codenames_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.codenames_days, public.codenames_runs TO service_role;

DROP TRIGGER IF EXISTS set_codenames_days_updated_at ON public.codenames_days;
CREATE TRIGGER set_codenames_days_updated_at
  BEFORE UPDATE ON public.codenames_days
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_codenames_runs_updated_at ON public.codenames_runs;
CREATE TRIGGER set_codenames_runs_updated_at
  BEFORE UPDATE ON public.codenames_runs
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
