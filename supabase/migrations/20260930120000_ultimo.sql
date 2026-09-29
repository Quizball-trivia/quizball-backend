-- Último en pie futbolero: a daily set of 5 closed-list categories (name as many answers as you can, one clock
-- per answer), and the third friend-duel game. The day content lives in ultimo_days (seeded by
-- scripts/ultimo-seed-days.ts from private files); every run, a member's or a guest session's, is an ultimo_runs
-- row. Both tables are new and empty here, so the plain index builds block nothing. The duel game checks gain
-- 'ultimo' NOT VALID here and are validated (and the old ones dropped) by the next migration.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.ultimo_days (
  day date PRIMARY KEY,
  number integer NOT NULL,
  -- A hash of the full categories JSON (up to 2^32), wider than int4: any content change is a new version.
  content_version bigint NOT NULL,
  -- Server-only: [{id, difficulty, title: {es, en, ka, tr}, hint: {…}, answers: [{id, display: {…}, aliases: […]}]}] x5.
  categories jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ultimo_days_number CHECK (number > 0),
  CONSTRAINT chk_ultimo_days_content_version CHECK (content_version > 0),
  CONSTRAINT chk_ultimo_days_categories CHECK (jsonb_typeof(categories) = 'array')
);

-- A run belongs to a member (user_id) or to a guest session (guest_id), never both; guest runs go with their
-- session when the guest sweeper retires it.
CREATE TABLE IF NOT EXISTS public.ultimo_runs (
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
  -- Names said over the day (the board's second column).
  answers integer,
  completed_at timestamptz,
  -- Buenos Aires midnight ending `day`: ranked writes are fenced and unsaid answers disclosed against the
  -- database clock at this instant.
  closes_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ultimo_runs_user_day UNIQUE (user_id, day),
  CONSTRAINT chk_ultimo_runs_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
  CONSTRAINT chk_ultimo_runs_ranked_member CHECK (NOT ranked OR user_id IS NOT NULL),
  CONSTRAINT chk_ultimo_runs_content_version CHECK (content_version > 0),
  CONSTRAINT chk_ultimo_runs_state_version CHECK (state_version >= 0),
  -- 5 categories of at most 60 answers, plus a 5-point bonus for each list named in full.
  CONSTRAINT chk_ultimo_runs_score CHECK (score BETWEEN 0 AND 325),
  CONSTRAINT chk_ultimo_runs_answers CHECK (answers BETWEEN 0 AND 300),
  CONSTRAINT chk_ultimo_runs_done CHECK (done = (completed_at IS NOT NULL)),
  CONSTRAINT chk_ultimo_runs_done_result CHECK (NOT done OR (score IS NOT NULL AND answers IS NOT NULL)),
  CONSTRAINT chk_ultimo_runs_closes_at CHECK (closes_at > day::timestamp AT TIME ZONE 'UTC')
);

-- One run per player per day: uq_ultimo_runs_user_day binds members (NULL user_ids are distinct); guest runs get
-- the same rule. The index also serves the guest_sessions ON DELETE CASCADE lookup.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ultimo_runs_guest_day
  ON public.ultimo_runs (guest_id, day)
  WHERE guest_id IS NOT NULL;

-- The board reads ranked, finished runs only.
CREATE INDEX IF NOT EXISTS idx_ultimo_runs_leaderboard
  ON public.ultimo_runs (day, score DESC NULLS LAST, completed_at)
  WHERE ranked AND done;

-- The settling sweep reads unfinished runs only.
CREATE INDEX IF NOT EXISTS idx_ultimo_runs_unfinished
  ON public.ultimo_runs (id)
  WHERE NOT done;

-- Append-only record of every category the seeds published, per side (days / duel pool): a list played on one side can
-- never be seeded onto the other, even after its stored copy is replaced or disabled.
CREATE TABLE IF NOT EXISTS public.ultimo_content_ledger (
  id bigserial PRIMARY KEY,
  side text NOT NULL,
  category_id text NOT NULL,
  keys jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ultimo_content_ledger_side CHECK (side IN ('day', 'pool'))
);
CREATE INDEX IF NOT EXISTS idx_ultimo_content_ledger_side ON public.ultimo_content_ledger (side, category_id);

-- Server-only (RLS without policies, no client grants): categories and answers must never be readable through
-- the Data API.
ALTER TABLE public.ultimo_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ultimo_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ultimo_content_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ultimo_days, public.ultimo_runs, public.ultimo_content_ledger FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.ultimo_days, public.ultimo_runs, public.ultimo_content_ledger TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.ultimo_content_ledger_id_seq TO service_role;

DROP TRIGGER IF EXISTS set_ultimo_days_updated_at ON public.ultimo_days;
CREATE TRIGGER set_ultimo_days_updated_at
  BEFORE UPDATE ON public.ultimo_days
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_ultimo_runs_updated_at ON public.ultimo_runs;
CREATE TRIGGER set_ultimo_runs_updated_at
  BEFORE UPDATE ON public.ultimo_runs
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

-- Duels: when the current pause began (resume grants at most the time actually paused). Nullable, no default:
-- a metadata-only change.
ALTER TABLE public.duel_matches ADD COLUMN IF NOT EXISTS paused_at timestamptz;

-- The third duel game, in all three places that name the games.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lobbies_duel_game_check_v2' AND conrelid = 'public.lobbies'::regclass) THEN
    -- NULL-safe as before: a duel room always names its game; no other room has one.
    ALTER TABLE public.lobbies
      ADD CONSTRAINT lobbies_duel_game_check_v2 CHECK (
        (game_mode IS DISTINCT FROM 'duel' AND duel_game IS NULL)
        OR (game_mode IS NOT DISTINCT FROM 'duel' AND duel_game IS NOT NULL AND duel_game IN ('buscaminas', 'pistas', 'ultimo'))
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_duel_pool_game_v2' AND conrelid = 'public.duel_pool'::regclass) THEN
    ALTER TABLE public.duel_pool ADD CONSTRAINT chk_duel_pool_game_v2 CHECK (game IN ('buscaminas', 'pistas', 'ultimo')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_duel_matches_game_v2' AND conrelid = 'public.duel_matches'::regclass) THEN
    ALTER TABLE public.duel_matches ADD CONSTRAINT chk_duel_matches_game_v2 CHECK (game IN ('buscaminas', 'pistas', 'ultimo')) NOT VALID;
  END IF;
END $$;
