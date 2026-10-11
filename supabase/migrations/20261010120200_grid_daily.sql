-- Daily grid: one Tic Tac Toe board a day, played alone. A player has nine guesses to fill the nine cells; the
-- board is the score (cells filled), then the time it took. grid_daily_days names each day's board (seeded by
-- scripts/grid-daily-seed-days.ts from the published boards); every run, a member's or a guest session's, is a
-- grid_daily_runs row. Only a member's run of the live day is ranked.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.grid_daily_days (
  day date PRIMARY KEY,
  number integer NOT NULL,
  content_version bigint NOT NULL,
  -- {boardId}: the board's own rows hold the clues and the answers.
  board jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_grid_daily_days_number CHECK (number > 0),
  CONSTRAINT chk_grid_daily_days_content_version CHECK (content_version > 0),
  CONSTRAINT chk_grid_daily_days_board CHECK (jsonb_typeof(board) = 'object')
);

CREATE TABLE IF NOT EXISTS public.grid_daily_runs (
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
  -- Seconds left of the hour a run is timed against: the board's tie-break after the score.
  speed integer,
  completed_at timestamptz,
  closes_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_grid_daily_runs_user_day UNIQUE (user_id, day),
  CONSTRAINT chk_grid_daily_runs_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
  CONSTRAINT chk_grid_daily_runs_ranked_member CHECK (NOT ranked OR user_id IS NOT NULL),
  CONSTRAINT chk_grid_daily_runs_content_version CHECK (content_version > 0),
  CONSTRAINT chk_grid_daily_runs_state_version CHECK (state_version >= 0),
  CONSTRAINT chk_grid_daily_runs_score CHECK (score BETWEEN 0 AND 9),
  CONSTRAINT chk_grid_daily_runs_speed CHECK (speed BETWEEN 0 AND 3600),
  CONSTRAINT chk_grid_daily_runs_done CHECK (done = (completed_at IS NOT NULL)),
  CONSTRAINT chk_grid_daily_runs_done_result CHECK (NOT done OR (score IS NOT NULL AND speed IS NOT NULL)),
  CONSTRAINT chk_grid_daily_runs_closes_at CHECK (closes_at > day::timestamp AT TIME ZONE 'UTC')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_grid_daily_runs_guest_day
  ON public.grid_daily_runs (guest_id, day)
  WHERE guest_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_grid_daily_runs_leaderboard
  ON public.grid_daily_runs (day, score DESC NULLS LAST, speed DESC NULLS LAST, completed_at)
  WHERE ranked AND done;

ALTER TABLE public.grid_daily_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grid_daily_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.grid_daily_days, public.grid_daily_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.grid_daily_days, public.grid_daily_runs TO service_role;

DROP TRIGGER IF EXISTS set_grid_daily_days_updated_at ON public.grid_daily_days;
CREATE TRIGGER set_grid_daily_days_updated_at
  BEFORE UPDATE ON public.grid_daily_days
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_grid_daily_runs_updated_at ON public.grid_daily_runs;
CREATE TRIGGER set_grid_daily_runs_updated_at
  BEFORE UPDATE ON public.grid_daily_runs
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
