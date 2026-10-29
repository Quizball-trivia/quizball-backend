-- Football Darts 501: one category a day (every covered footballer with his number in it), one run per player, on the
-- daily-game kit. Rooms use the room runtime and the private room_pool. Misses are judged only for footballers a coverage
-- set holds complete numbers for (darts501_coverage), so an uncovered real footballer is a free answer, never a wrong
-- miss. Every table is private (RLS on, no client grants): a number reaches a player only as a dart thrown, or in the
-- review of a closed day.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.darts501_days (
  day date PRIMARY KEY,
  number integer NOT NULL,
  content_version bigint NOT NULL,
  -- The day's category: titles per language, unit, as-of, release, coverage set and every entry with its number.
  category jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_darts501_days_number CHECK (number > 0),
  CONSTRAINT chk_darts501_days_content_version CHECK (content_version > 0),
  CONSTRAINT chk_darts501_days_category CHECK (jsonb_typeof(category) = 'object')
);

CREATE TABLE IF NOT EXISTS public.darts501_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  guest_id uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
  day date NOT NULL,
  ranked boolean NOT NULL DEFAULT false,
  content_version bigint NOT NULL,
  state jsonb NOT NULL,
  state_version integer NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false,
  -- The board's whole order in one number (higher first): a checkout is 790..980, a run without one 0..500.
  score integer,
  -- Darts used (shown on the board; the order is already in score).
  darts integer,
  completed_at timestamptz,
  closes_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_darts501_runs_user_day UNIQUE (user_id, day),
  CONSTRAINT chk_darts501_runs_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
  CONSTRAINT chk_darts501_runs_ranked_member CHECK (NOT ranked OR user_id IS NOT NULL),
  CONSTRAINT chk_darts501_runs_content_version CHECK (content_version > 0),
  CONSTRAINT chk_darts501_runs_state_version CHECK (state_version >= 0),
  CONSTRAINT chk_darts501_runs_score CHECK (score BETWEEN 0 AND 1000),
  CONSTRAINT chk_darts501_runs_darts CHECK (darts BETWEEN 0 AND 10),
  CONSTRAINT chk_darts501_runs_done CHECK (done = (completed_at IS NOT NULL)),
  CONSTRAINT chk_darts501_runs_done_result CHECK (NOT done OR (score IS NOT NULL AND darts IS NOT NULL)),
  CONSTRAINT chk_darts501_runs_closes_at CHECK (closes_at > day::timestamp AT TIME ZONE 'UTC')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_darts501_runs_guest_day
  ON public.darts501_runs (guest_id, day)
  WHERE guest_id IS NOT NULL;

-- Board order: score, then the earlier finish.
CREATE INDEX IF NOT EXISTS idx_darts501_runs_leaderboard
  ON public.darts501_runs (day, score DESC NULLS LAST, completed_at)
  WHERE ranked AND done;

-- The footballers a source has complete numbers for, per coverage set (written once, then read whole into memory).
CREATE TABLE IF NOT EXISTS public.darts501_coverage (
  coverage_id text NOT NULL,
  pid text NOT NULL,
  PRIMARY KEY (coverage_id, pid),
  CONSTRAINT chk_darts501_coverage_id CHECK (char_length(coverage_id) BETWEEN 1 AND 40),
  CONSTRAINT chk_darts501_coverage_pid CHECK (char_length(pid) BETWEEN 1 AND 64)
);

-- Every category ever published, on either side (daily or room pool), kept when a day is corrected or a pool category
-- retired: the seeders refuse a topic the other side has ever shown, or a category that would show many of the same
-- footballer-and-number pairs (entry_keys, "pid=value"), which is what a player could carry from one side to the other.
CREATE TABLE IF NOT EXISTS public.darts501_ledger (
  side text NOT NULL,
  category_id text NOT NULL,
  -- The content's hash: a corrected day or pool category is a new row, and every revision ever shown is checked.
  revision text NOT NULL,
  topic_key text NOT NULL,
  title_en text NOT NULL,
  entry_keys text[] NOT NULL,
  day date,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (side, category_id, revision),
  CONSTRAINT chk_darts501_ledger_day CHECK ((side = 'daily') = (day IS NOT NULL)),
  CONSTRAINT chk_darts501_ledger_side CHECK (side IN ('daily', 'room'))
);
CREATE INDEX IF NOT EXISTS idx_darts501_ledger_topic ON public.darts501_ledger (topic_key);

ALTER TABLE public.darts501_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.darts501_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.darts501_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.darts501_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.darts501_days, public.darts501_runs, public.darts501_coverage, public.darts501_ledger FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.darts501_days, public.darts501_runs, public.darts501_coverage, public.darts501_ledger TO service_role;

DROP TRIGGER IF EXISTS set_darts501_days_updated_at ON public.darts501_days;
CREATE TRIGGER set_darts501_days_updated_at
  BEFORE UPDATE ON public.darts501_days
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_darts501_runs_updated_at ON public.darts501_runs;
CREATE TRIGGER set_darts501_runs_updated_at
  BEFORE UPDATE ON public.darts501_runs
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
