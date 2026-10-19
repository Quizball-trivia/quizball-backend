-- Dato falso futbolero: one footballer, a claim and five options, one of them fake. The daily is on the daily-game kit:
-- one day row (ten cards with their fakes and explanations), one run per player. Rooms use the room runtime and the
-- private room_pool. Every table is private (RLS on, no client grants): a fake reaches a player only through the
-- server's views, after that card is settled.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.dato_falso_days (
  day date PRIMARY KEY,
  number integer NOT NULL,
  content_version bigint NOT NULL,
  -- The day's ten cards: footballer, claim, five options with their art, the fake, the explanation per language.
  cards jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_dato_falso_days_number CHECK (number > 0),
  CONSTRAINT chk_dato_falso_days_content_version CHECK (content_version > 0),
  CONSTRAINT chk_dato_falso_days_cards CHECK (jsonb_typeof(cards) = 'object')
);

CREATE TABLE IF NOT EXISTS public.dato_falso_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  guest_id uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
  day date NOT NULL,
  ranked boolean NOT NULL DEFAULT false,
  content_version bigint NOT NULL,
  state jsonb NOT NULL,
  state_version integer NOT NULL DEFAULT 0,
  done boolean NOT NULL DEFAULT false,
  -- Points over ten cards: +1 right, +2 right with Doble o nada (once a run), −1 wrong with it: −1 to 11.
  score integer,
  -- Right answers: the board's tie-break.
  rights integer,
  completed_at timestamptz,
  closes_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_dato_falso_runs_user_day UNIQUE (user_id, day),
  CONSTRAINT chk_dato_falso_runs_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
  CONSTRAINT chk_dato_falso_runs_ranked_member CHECK (NOT ranked OR user_id IS NOT NULL),
  CONSTRAINT chk_dato_falso_runs_content_version CHECK (content_version > 0),
  CONSTRAINT chk_dato_falso_runs_state_version CHECK (state_version >= 0),
  CONSTRAINT chk_dato_falso_runs_score CHECK (score BETWEEN -1 AND 11),
  CONSTRAINT chk_dato_falso_runs_rights CHECK (rights BETWEEN 0 AND 10),
  CONSTRAINT chk_dato_falso_runs_done CHECK (done = (completed_at IS NOT NULL)),
  CONSTRAINT chk_dato_falso_runs_done_result CHECK (NOT done OR (score IS NOT NULL AND rights IS NOT NULL)),
  CONSTRAINT chk_dato_falso_runs_closes_at CHECK (closes_at > day::timestamp AT TIME ZONE 'UTC')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dato_falso_runs_guest_day
  ON public.dato_falso_runs (guest_id, day)
  WHERE guest_id IS NOT NULL;

-- Board order: points, then right answers, then the earlier finish.
CREATE INDEX IF NOT EXISTS idx_dato_falso_runs_leaderboard
  ON public.dato_falso_runs (day, score DESC NULLS LAST, rights DESC NULLS LAST, completed_at)
  WHERE ranked AND done;

-- The settle sweep: only runs whose card clock is open, by its deadline (ms). A run a player walked away from between
-- two cards stays unfinished for good and is not in it.
CREATE INDEX IF NOT EXISTS idx_dato_falso_runs_open_clock
  ON public.dato_falso_runs (((state->>'dl')::float8))
  WHERE NOT done AND state->>'open' = 'true';

-- Every card ever published, on either side (daily or room pool), kept when a day is corrected or a pool card retired:
-- the seeders refuse a footballer the other side has ever shown, so a replaced daily card cannot resurface in rooms.
-- One row per footballer and spelling a card id was ever about (a correction keeps the old ones too), and for a daily
-- card the day it was first shown (a corrected-out card never comes back on another day: its fake is known).
CREATE TABLE IF NOT EXISTS public.dato_falso_ledger (
  side text NOT NULL,
  card_id text NOT NULL,
  player_id text NOT NULL,
  player_name text NOT NULL,
  day date,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (side, card_id, player_id, player_name),
  CONSTRAINT chk_dato_falso_ledger_day CHECK ((side = 'daily') = (day IS NOT NULL)),
  CONSTRAINT chk_dato_falso_ledger_side CHECK (side IN ('daily', 'room'))
);
CREATE INDEX IF NOT EXISTS idx_dato_falso_ledger_player ON public.dato_falso_ledger (player_id);
CREATE INDEX IF NOT EXISTS idx_dato_falso_ledger_name ON public.dato_falso_ledger (player_name);

ALTER TABLE public.dato_falso_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dato_falso_ledger FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.dato_falso_ledger TO service_role;

ALTER TABLE public.dato_falso_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dato_falso_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dato_falso_days, public.dato_falso_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.dato_falso_days, public.dato_falso_runs TO service_role;

DROP TRIGGER IF EXISTS set_dato_falso_days_updated_at ON public.dato_falso_days;
CREATE TRIGGER set_dato_falso_days_updated_at
  BEFORE UPDATE ON public.dato_falso_days
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

DROP TRIGGER IF EXISTS set_dato_falso_runs_updated_at ON public.dato_falso_runs;
CREATE TRIGGER set_dato_falso_runs_updated_at
  BEFORE UPDATE ON public.dato_falso_runs
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
