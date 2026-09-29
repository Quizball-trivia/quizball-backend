-- Pistas futboleras: a daily set of 10 hidden footballers, 10 clues each, revealed one at a time.
-- The day content lives in pistas_days (seeded by scripts/pistas-seed-days.ts from private files) and
-- every run, a member's or a guest session's, is a pistas_runs row. Only a member's run of the live
-- ranked day is ranked. Both tables are new and empty here, so the plain index builds block nothing.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.pistas_days (
  day date PRIMARY KEY,
  number integer NOT NULL,
  -- A hash of the full rounds JSON (up to 2^32), wider than int4: any content change is a new version.
  content_version bigint NOT NULL,
  -- Server-only: [{id, difficulty, clues: [{kind, icon, text: {es, en, ka, tr}}] x10,
  --                answer: {display: {es, en, ka, tr}, accepted: [...]}}] x10.
  rounds jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_pistas_days_number CHECK (number > 0),
  CONSTRAINT chk_pistas_days_content_version CHECK (content_version > 0),
  CONSTRAINT chk_pistas_days_rounds CHECK (jsonb_typeof(rounds) = 'array')
);

-- A run belongs to a member (user_id) or to a guest session (guest_id), never both; guest runs go
-- with their session when the guest sweeper retires it.
CREATE TABLE IF NOT EXISTS public.pistas_runs (
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
  solved integer,
  completed_at timestamptz,
  -- Buenos Aires midnight ending `day`: ranked writes are fenced and missed answers disclosed against
  -- the database clock at this instant.
  closes_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_pistas_runs_user_day UNIQUE (user_id, day),
  CONSTRAINT chk_pistas_runs_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
  CONSTRAINT chk_pistas_runs_ranked_member CHECK (NOT ranked OR user_id IS NOT NULL),
  CONSTRAINT chk_pistas_runs_content_version CHECK (content_version > 0),
  CONSTRAINT chk_pistas_runs_state_version CHECK (state_version >= 0),
  CONSTRAINT chk_pistas_runs_score CHECK (score BETWEEN 0 AND 100),
  CONSTRAINT chk_pistas_runs_solved CHECK (solved BETWEEN 0 AND 10),
  CONSTRAINT chk_pistas_runs_done CHECK (done = (completed_at IS NOT NULL)),
  CONSTRAINT chk_pistas_runs_done_result CHECK (NOT done OR (score IS NOT NULL AND solved IS NOT NULL)),
  CONSTRAINT chk_pistas_runs_closes_at CHECK (closes_at > day::timestamp AT TIME ZONE 'UTC')
);

-- One run per player per day: uq_pistas_runs_user_day binds members (NULL user_ids are distinct);
-- guest runs get the same rule. The index also serves the guest_sessions ON DELETE CASCADE lookup.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pistas_runs_guest_day
  ON public.pistas_runs (guest_id, day)
  WHERE guest_id IS NOT NULL;

-- The board reads ranked, finished runs only.
CREATE INDEX IF NOT EXISTS idx_pistas_runs_leaderboard
  ON public.pistas_runs (day, score DESC NULLS LAST, completed_at)
  WHERE ranked AND done;

-- Server-only (RLS without policies, no client grants): clues and answers must never be readable
-- through the Data API.
ALTER TABLE public.pistas_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pistas_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pistas_days, public.pistas_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pistas_days, public.pistas_runs TO service_role;

DROP TRIGGER IF EXISTS set_pistas_days_updated_at ON public.pistas_days;
CREATE TRIGGER set_pistas_days_updated_at
  BEFORE UPDATE ON public.pistas_days
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_pistas_runs_updated_at ON public.pistas_runs;
CREATE TRIGGER set_pistas_runs_updated_at
  BEFORE UPDATE ON public.pistas_runs
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
