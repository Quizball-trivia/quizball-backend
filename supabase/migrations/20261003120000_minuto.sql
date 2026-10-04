-- "¿En qué minuto?": a daily set of 10 famous goals; players guess the minute of each. The day content lives in
-- minuto_days (seeded by scripts/minuto-seed-days.ts from private files); every run, a member's or a guest
-- session's, is a minuto_runs row. Only a member's run of the live ranked day is ranked. It is also the fourth
-- friend-duel game: the three checks that name the duel games get a wider 'minuto' version here (NOT VALID),
-- validated by the next migration and swapped in by the one after.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.minuto_days (
  day date PRIMARY KEY,
  number integer NOT NULL,
  -- A hash of the full goals JSON (up to 2^32): any content change is a new version.
  content_version bigint NOT NULL,
  -- Server-only: [{id, fingerprint, tier, comp, year, date, stage, group, leg, home, away, score, aet, pens, side,
  --                scorer, penalty, scoreAfter, image, minute: {base, added}}] x10.
  goals jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_minuto_days_number CHECK (number > 0),
  CONSTRAINT chk_minuto_days_content_version CHECK (content_version > 0),
  CONSTRAINT chk_minuto_days_goals CHECK (jsonb_typeof(goals) = 'array')
);

-- A run belongs to a member (user_id) or to a guest session (guest_id), never both; guest runs go with their
-- session when the guest sweeper retires it.
CREATE TABLE IF NOT EXISTS public.minuto_runs (
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
  -- Exact minutes: the board's tie-break after the score.
  exact integer,
  completed_at timestamptz,
  -- Buenos Aires midnight ending `day`: ranked writes are fenced and the day's review opens at this instant.
  closes_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_minuto_runs_user_day UNIQUE (user_id, day),
  CONSTRAINT chk_minuto_runs_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
  CONSTRAINT chk_minuto_runs_ranked_member CHECK (NOT ranked OR user_id IS NOT NULL),
  CONSTRAINT chk_minuto_runs_content_version CHECK (content_version > 0),
  CONSTRAINT chk_minuto_runs_state_version CHECK (state_version >= 0),
  CONSTRAINT chk_minuto_runs_score CHECK (score BETWEEN 0 AND 30),
  CONSTRAINT chk_minuto_runs_exact CHECK (exact BETWEEN 0 AND 10),
  CONSTRAINT chk_minuto_runs_done CHECK (done = (completed_at IS NOT NULL)),
  CONSTRAINT chk_minuto_runs_done_result CHECK (NOT done OR (score IS NOT NULL AND exact IS NOT NULL)),
  CONSTRAINT chk_minuto_runs_closes_at CHECK (closes_at > day::timestamp AT TIME ZONE 'UTC')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_minuto_runs_guest_day
  ON public.minuto_runs (guest_id, day)
  WHERE guest_id IS NOT NULL;

-- The board reads ranked, finished runs only, in its own order (score, exact minutes, finish).
CREATE INDEX IF NOT EXISTS idx_minuto_runs_leaderboard
  ON public.minuto_runs (day, score DESC NULLS LAST, exact DESC NULLS LAST, completed_at)
  WHERE ranked AND done;

-- Every goal ever published on each side (days, duel pool): append-only, so a goal replaced or disabled after it
-- was played is still known to the overlap check.
CREATE TABLE IF NOT EXISTS public.minuto_content_ledger (
  id bigserial PRIMARY KEY,
  side text NOT NULL,
  goal_id text NOT NULL,
  fingerprint text NOT NULL,
  -- The day that published it (days side only): a corrected calendar may not move a disclosed goal to another day.
  day date,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_minuto_content_ledger_side CHECK (side IN ('day', 'pool')),
  CONSTRAINT chk_minuto_content_ledger_day CHECK ((side = 'day') = (day IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_minuto_content_ledger_side ON public.minuto_content_ledger (side, goal_id);

-- Server-only (RLS without policies, no client grants): minutes must never be readable through the Data API.
ALTER TABLE public.minuto_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.minuto_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.minuto_content_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.minuto_days, public.minuto_runs, public.minuto_content_ledger FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.minuto_days, public.minuto_runs, public.minuto_content_ledger TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.minuto_content_ledger_id_seq TO service_role;

DROP TRIGGER IF EXISTS set_minuto_days_updated_at ON public.minuto_days;
CREATE TRIGGER set_minuto_days_updated_at
  BEFORE UPDATE ON public.minuto_days
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_minuto_runs_updated_at ON public.minuto_runs;
CREATE TRIGGER set_minuto_runs_updated_at
  BEFORE UPDATE ON public.minuto_runs
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

-- The fourth duel game, in all three places that name the games.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lobbies_duel_game_check_v3' AND conrelid = 'public.lobbies'::regclass) THEN
    -- NULL-safe as before: a duel room always names its game; no other room has one.
    ALTER TABLE public.lobbies
      ADD CONSTRAINT lobbies_duel_game_check_v3 CHECK (
        (game_mode IS DISTINCT FROM 'duel' AND duel_game IS NULL)
        OR (game_mode IS NOT DISTINCT FROM 'duel' AND duel_game IS NOT NULL AND duel_game IN ('buscaminas', 'pistas', 'ultimo', 'minuto'))
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_duel_pool_game_v3' AND conrelid = 'public.duel_pool'::regclass) THEN
    ALTER TABLE public.duel_pool ADD CONSTRAINT chk_duel_pool_game_v3 CHECK (game IN ('buscaminas', 'pistas', 'ultimo', 'minuto')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_duel_matches_game_v3' AND conrelid = 'public.duel_matches'::regclass) THEN
    ALTER TABLE public.duel_matches ADD CONSTRAINT chk_duel_matches_game_v3 CHECK (game IN ('buscaminas', 'pistas', 'ultimo', 'minuto')) NOT VALID;
  END IF;
END $$;
