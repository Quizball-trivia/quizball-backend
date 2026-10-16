-- Football Horserace: players race nations by picking stats; the nation that leads a stat moves. Values come from frozen
-- data releases (one row per tournament of a release), never edited: a correction is a new release, so a running match
-- or a day already played keeps its numbers. The daily race is on the daily-game kit: one day row, one run per player.
-- Every table is private (RLS on, no client grants): values reach a player only through the server's views.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.football_race_releases (
  release text PRIMARY KEY,
  cutoff date NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_football_race_releases_id CHECK (release ~ '^[0-9a-z][0-9a-z.-]{2,59}$')
);

CREATE TABLE IF NOT EXISTS public.football_race_tournaments (
  release text NOT NULL REFERENCES public.football_race_releases(release),
  tournament text NOT NULL,
  -- RaceTournamentData (football-race.rules.ts): nations, eras, wording, every value.
  payload jsonb NOT NULL,
  checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (release, tournament),
  CONSTRAINT chk_football_race_tournaments_id CHECK (tournament ~ '^[A-Z0-9]{2,20}$'),
  CONSTRAINT chk_football_race_tournaments_payload CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT chk_football_race_tournaments_checksum CHECK (checksum ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS public.football_race_days (
  day date PRIMARY KEY,
  number integer NOT NULL,
  content_version bigint NOT NULL,
  -- The day's race, self-contained: tournament, the four nations (yours first), the stats with their values.
  race jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_football_race_days_number CHECK (number > 0),
  CONSTRAINT chk_football_race_days_content_version CHECK (content_version > 0),
  CONSTRAINT chk_football_race_days_race CHECK (jsonb_typeof(race) = 'object')
);

CREATE TABLE IF NOT EXISTS public.football_race_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  guest_id uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
  day date NOT NULL,
  ranked boolean NOT NULL DEFAULT false,
  content_version bigint NOT NULL,
  state jsonb NOT NULL,
  state_version integer NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false,
  -- Won: 1000 − picks (995 = perfect). Lost: how far your nation got × 100 + (99 − picks). One number orders the board.
  score integer,
  -- Picks used: the board's tie-break (fewer first).
  picks integer,
  completed_at timestamptz,
  closes_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_football_race_runs_user_day UNIQUE (user_id, day),
  CONSTRAINT chk_football_race_runs_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
  CONSTRAINT chk_football_race_runs_ranked_member CHECK (NOT ranked OR user_id IS NOT NULL),
  CONSTRAINT chk_football_race_runs_content_version CHECK (content_version > 0),
  CONSTRAINT chk_football_race_runs_state_version CHECK (state_version >= 0),
  CONSTRAINT chk_football_race_runs_score CHECK (score BETWEEN 0 AND 1000),
  CONSTRAINT chk_football_race_runs_picks CHECK (picks BETWEEN 0 AND 400),
  CONSTRAINT chk_football_race_runs_done CHECK (done = (completed_at IS NOT NULL)),
  CONSTRAINT chk_football_race_runs_done_result CHECK (NOT done OR (score IS NOT NULL AND picks IS NOT NULL)),
  CONSTRAINT chk_football_race_runs_closes_at CHECK (closes_at > day::timestamp AT TIME ZONE 'UTC')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_football_race_runs_guest_day
  ON public.football_race_runs (guest_id, day)
  WHERE guest_id IS NOT NULL;

-- Board order: score (fewer picks already counted in it), then the earlier finish.
CREATE INDEX IF NOT EXISTS idx_football_race_runs_leaderboard
  ON public.football_race_runs (day, score DESC NULLS LAST, completed_at)
  WHERE ranked AND done;

ALTER TABLE public.football_race_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_race_tournaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_race_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_race_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.football_race_releases, public.football_race_tournaments, public.football_race_days, public.football_race_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.football_race_releases, public.football_race_tournaments, public.football_race_days, public.football_race_runs TO service_role;

DROP TRIGGER IF EXISTS set_football_race_days_updated_at ON public.football_race_days;
CREATE TRIGGER set_football_race_days_updated_at
  BEFORE UPDATE ON public.football_race_days
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_football_race_runs_updated_at ON public.football_race_runs;
CREATE TRIGGER set_football_race_runs_updated_at
  BEFORE UPDATE ON public.football_race_runs
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
