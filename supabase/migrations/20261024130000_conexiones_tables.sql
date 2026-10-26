-- Conexiones futboleras: sixteen footballers in four hidden groups of four. The daily is on the daily-game kit: one day
-- row (the board with its groups, links and decoys), one run per player. The 1v1 uses the room runtime and the private
-- room_pool. Every table is private (RLS on, no client grants): a group reaches a player only through the server's
-- views, once it is solved or the game is over.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.conexiones_days (
  day date PRIMARY KEY,
  number integer NOT NULL,
  content_version bigint NOT NULL,
  -- The day's board: sixteen tiles, four groups with their tier, link, note and naming decoys per language.
  board jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_conexiones_days_number CHECK (number > 0),
  CONSTRAINT chk_conexiones_days_content_version CHECK (content_version > 0),
  CONSTRAINT chk_conexiones_days_board CHECK (jsonb_typeof(board) = 'object')
);

CREATE TABLE IF NOT EXISTS public.conexiones_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  guest_id uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
  day date NOT NULL,
  ranked boolean NOT NULL DEFAULT false,
  content_version bigint NOT NULL,
  state jsonb NOT NULL,
  state_version integer NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false,
  -- Groups found plus, on a solved board, the mistakes left: a lost run 0–3, a won one 5–8.
  score integer,
  -- Seconds from opening the board to the last guess: the board's tie-break (fewer first).
  secs integer,
  completed_at timestamptz,
  closes_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_conexiones_runs_user_day UNIQUE (user_id, day),
  CONSTRAINT chk_conexiones_runs_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
  CONSTRAINT chk_conexiones_runs_ranked_member CHECK (NOT ranked OR user_id IS NOT NULL),
  CONSTRAINT chk_conexiones_runs_content_version CHECK (content_version > 0),
  CONSTRAINT chk_conexiones_runs_state_version CHECK (state_version >= 0),
  CONSTRAINT chk_conexiones_runs_score CHECK (score BETWEEN 0 AND 8 AND score <> 4),
  CONSTRAINT chk_conexiones_runs_secs CHECK (secs BETWEEN 0 AND 172800),
  CONSTRAINT chk_conexiones_runs_done CHECK (done = (completed_at IS NOT NULL)),
  CONSTRAINT chk_conexiones_runs_done_result CHECK (NOT done OR (score IS NOT NULL AND secs IS NOT NULL)),
  CONSTRAINT chk_conexiones_runs_closes_at CHECK (closes_at > day::timestamp AT TIME ZONE 'UTC')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_conexiones_runs_guest_day
  ON public.conexiones_runs (guest_id, day)
  WHERE guest_id IS NOT NULL;

-- Board order: score, then fewer seconds, then the earlier finish.
CREATE INDEX IF NOT EXISTS idx_conexiones_runs_leaderboard
  ON public.conexiones_runs (day, score DESC NULLS LAST, secs ASC NULLS LAST, completed_at)
  WHERE ranked AND done;

-- Every group ever published, on either side (daily or room pool), one row per footballer, kept when a day is
-- corrected or a pool board retired: the seeders refuse a group the other side has ever shown (three of its
-- footballers together under any link, or the same link with a second shared footballer), by id and by name, so a
-- replaced daily group cannot resurface in rooms.
CREATE TABLE IF NOT EXISTS public.conexiones_ledger (
  side text NOT NULL,
  board_id text NOT NULL,
  group_id text NOT NULL,
  link_key text NOT NULL,
  player_id text NOT NULL,
  player_name text NOT NULL,
  day date,
  published_at timestamptz NOT NULL DEFAULT now(),
  -- The link is part of the key: a correction that changes a group's link keeps the old version too.
  PRIMARY KEY (side, board_id, group_id, link_key, player_id),
  CONSTRAINT chk_conexiones_ledger_day CHECK ((side = 'daily') = (day IS NOT NULL)),
  CONSTRAINT chk_conexiones_ledger_side CHECK (side IN ('daily', 'room'))
);
CREATE INDEX IF NOT EXISTS idx_conexiones_ledger_link ON public.conexiones_ledger (link_key);
CREATE INDEX IF NOT EXISTS idx_conexiones_ledger_board ON public.conexiones_ledger (board_id);
CREATE INDEX IF NOT EXISTS idx_conexiones_ledger_player ON public.conexiones_ledger (player_id);
CREATE INDEX IF NOT EXISTS idx_conexiones_ledger_name ON public.conexiones_ledger (player_name);

ALTER TABLE public.conexiones_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conexiones_ledger FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.conexiones_ledger TO service_role;

ALTER TABLE public.conexiones_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conexiones_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conexiones_days, public.conexiones_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.conexiones_days, public.conexiones_runs TO service_role;

DROP TRIGGER IF EXISTS set_conexiones_days_updated_at ON public.conexiones_days;
CREATE TRIGGER set_conexiones_days_updated_at
  BEFORE UPDATE ON public.conexiones_days
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_conexiones_runs_updated_at ON public.conexiones_runs;
CREATE TRIGGER set_conexiones_runs_updated_at
  BEFORE UPDATE ON public.conexiones_runs
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
