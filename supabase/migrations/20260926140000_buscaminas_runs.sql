-- Buscaminas futbolero: one ranked run per signed-in user per release day.
-- Guests and past days play on stateless signed tokens and never touch this table.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The leaderboard index is built only together with the table, inside this same
-- transaction, where a plain CREATE INDEX blocks nothing. If the table already exists
-- (ledger out of sync with the schema) a write-blocking build on a live table is
-- skipped with a warning; build it out of band with CREATE INDEX CONCURRENTLY.
DO $$
BEGIN
  IF to_regclass('public.buscaminas_runs') IS NULL THEN
    CREATE TABLE public.buscaminas_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      day date NOT NULL,
      -- A content hash (up to 2^32), wider than int4.
      content_version bigint NOT NULL,
      state jsonb NOT NULL,
      state_version integer NOT NULL DEFAULT 0,
      done boolean NOT NULL DEFAULT false,
      score integer,
      perfects integer,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT uq_buscaminas_runs_user_day UNIQUE (user_id, day),
      CONSTRAINT chk_buscaminas_runs_content_version CHECK (content_version > 0),
      CONSTRAINT chk_buscaminas_runs_state_version CHECK (state_version >= 0),
      CONSTRAINT chk_buscaminas_runs_score CHECK (score BETWEEN 0 AND 300),
      CONSTRAINT chk_buscaminas_runs_perfects CHECK (perfects BETWEEN 0 AND 20),
      CONSTRAINT chk_buscaminas_runs_done CHECK (done = (completed_at IS NOT NULL)),
      CONSTRAINT chk_buscaminas_runs_done_result CHECK (NOT done OR (score IS NOT NULL AND perfects IS NOT NULL))
    );
    CREATE INDEX idx_buscaminas_runs_leaderboard
      ON public.buscaminas_runs (day, score DESC NULLS LAST, completed_at)
      WHERE done;
  ELSIF to_regclass('public.idx_buscaminas_runs_leaderboard') IS NULL THEN
    RAISE WARNING 'public.buscaminas_runs already exists without idx_buscaminas_runs_leaderboard; not building it here (it would block writes). Run: CREATE INDEX CONCURRENTLY idx_buscaminas_runs_leaderboard ON public.buscaminas_runs (day, score DESC NULLS LAST, completed_at) WHERE done;';
  END IF;
END
$$;

ALTER TABLE public.buscaminas_runs ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_buscaminas_runs_updated_at ON public.buscaminas_runs;
CREATE TRIGGER set_buscaminas_runs_updated_at
  BEFORE UPDATE ON public.buscaminas_runs
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
