-- Buscaminas futbolero like the other game modes: the day content lives in the database
-- (buscaminas_days, seeded by scripts/buscaminas-seed-days.ts) and every run, a member's or a
-- guest session's, is a buscaminas_runs row. Only a member's run of the live day is ranked.
-- Applies on top of 20260926140000_buscaminas_runs (staging: member runs exist; prod: fresh).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.buscaminas_days (
  day date PRIMARY KEY,
  number integer NOT NULL,
  -- The answer hash (up to 2^32), wider than int4.
  content_version bigint NOT NULL,
  -- Public: {"rounds": [{id, difficulty, prompt: {es, en, ka, tr}, cards: [{id, name, img}]}]}.
  board jsonb NOT NULL,
  -- Server-only: {"<round id>": ["<card id that fits the clue>", ...]}.
  answers jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_buscaminas_days_number CHECK (number > 0),
  CONSTRAINT chk_buscaminas_days_content_version CHECK (content_version > 0),
  CONSTRAINT chk_buscaminas_days_board CHECK (jsonb_typeof(board) = 'object' AND jsonb_typeof(board -> 'rounds') = 'array'),
  CONSTRAINT chk_buscaminas_days_answers CHECK (jsonb_typeof(answers) = 'object')
);

-- Server-only (RLS without policies, no client grants): the answers must never be readable through the Data API.
ALTER TABLE public.buscaminas_days ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buscaminas_days, public.buscaminas_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.buscaminas_days, public.buscaminas_runs TO service_role;

DROP TRIGGER IF EXISTS set_buscaminas_days_updated_at ON public.buscaminas_days;
CREATE TRIGGER set_buscaminas_days_updated_at
  BEFORE UPDATE ON public.buscaminas_days
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

-- A run belongs to a member (user_id) or to a guest session (guest_id), never both.
-- Guest runs go with their session when the guest sweeper retires it.
ALTER TABLE public.buscaminas_runs ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.buscaminas_runs
  ADD COLUMN IF NOT EXISTS guest_id uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE;

-- Every run stored so far is a member's ranked run of its live day: existing rows take true
-- (a constant default, no table rewrite), new rows default to false.
ALTER TABLE public.buscaminas_runs ADD COLUMN IF NOT EXISTS ranked boolean NOT NULL DEFAULT true;
ALTER TABLE public.buscaminas_runs ALTER COLUMN ranked SET DEFAULT false;

ALTER TABLE public.buscaminas_runs DROP CONSTRAINT IF EXISTS chk_buscaminas_runs_owner;
ALTER TABLE public.buscaminas_runs
  ADD CONSTRAINT chk_buscaminas_runs_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL));
ALTER TABLE public.buscaminas_runs DROP CONSTRAINT IF EXISTS chk_buscaminas_runs_ranked_member;
ALTER TABLE public.buscaminas_runs
  ADD CONSTRAINT chk_buscaminas_runs_ranked_member CHECK (NOT ranked OR user_id IS NOT NULL);

-- One run per player per day. uq_buscaminas_runs_user_day (user_id, day) already binds member
-- runs only (NULL user_ids are distinct); guest runs get the same rule. The index also serves the
-- guest_sessions ON DELETE CASCADE lookup. The table is small (staging) or empty (prod), so the
-- plain builds below are brief.
CREATE UNIQUE INDEX IF NOT EXISTS uq_buscaminas_runs_guest_day
  ON public.buscaminas_runs (guest_id, day)
  WHERE guest_id IS NOT NULL;

-- The board reads ranked, finished runs only.
DROP INDEX IF EXISTS public.idx_buscaminas_runs_leaderboard;
CREATE INDEX idx_buscaminas_runs_leaderboard
  ON public.buscaminas_runs (day, score DESC NULLS LAST, completed_at)
  WHERE ranked AND done;
