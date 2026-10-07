-- Freecroco Road to Goal and Trivia Mines (contract §7.5–7.6): free skill variants with no wallet, stake, coin
-- ledger, bots or RTP. One run per partner play; kept apart from road_to_goal_rounds / trivia_mines_rounds so partner
-- players never appear in the site's live feeds, top runs, bot rosters or coin reconciliation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.partner_rtg_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  play_id uuid NOT NULL UNIQUE REFERENCES public.partner_plays(id),
  player_id uuid NOT NULL REFERENCES public.partner_players(id),
  status text NOT NULL DEFAULT 'active',
  phase text NOT NULL DEFAULT 'question',
  state_version integer NOT NULL DEFAULT 1,
  cleared_zones integer NOT NULL DEFAULT 0,
  -- The 11 dealt questions with their correct options: server only, never returned while the zone is open.
  questions jsonb NOT NULL,
  question_ids uuid[] NOT NULL,
  -- Server deadline (visible clock + network grace).
  question_deadline_at timestamptz,
  decision_deadline_at timestamptz,
  last_answer jsonb,
  score integer,
  settlement_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  -- 'cancelled': the play was cancelled by a block (no event).
  CONSTRAINT chk_partner_rtg_runs_status CHECK (status IN ('active', 'cashed', 'lost', 'completed', 'cancelled')),
  CONSTRAINT chk_partner_rtg_runs_phase CHECK (phase IN ('question', 'decision', 'settled')),
  CONSTRAINT chk_partner_rtg_runs_zones CHECK (cleared_zones BETWEEN 0 AND 11),
  CONSTRAINT chk_partner_rtg_runs_score CHECK (score IS NULL OR score BETWEEN 0 AND 400),
  CONSTRAINT chk_partner_rtg_runs_settled CHECK ((status = 'active') = (phase <> 'settled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_rtg_runs_active_player
  ON public.partner_rtg_runs (player_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_partner_rtg_runs_player_recent
  ON public.partner_rtg_runs (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_rtg_runs_open_deadlines
  ON public.partner_rtg_runs (LEAST(question_deadline_at, decision_deadline_at)) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS public.partner_mines_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  play_id uuid NOT NULL UNIQUE REFERENCES public.partner_plays(id),
  player_id uuid NOT NULL REFERENCES public.partner_players(id),
  status text NOT NULL DEFAULT 'active',
  phase text NOT NULL DEFAULT 'picking',
  state_version integer NOT NULL DEFAULT 1,
  -- FAIR value in thousandths of a point; the 0.97 margin, the rounding and the 1,000 cap apply once at cash-out.
  pot_milli bigint NOT NULL,
  opened integer[] NOT NULL DEFAULT '{}',
  flagged integer[] NOT NULL DEFAULT '{}',
  bust_tile integer,
  scouts_left integer NOT NULL DEFAULT 3,
  question_id uuid,
  question_payload jsonb,
  question_correct_option text,
  question_deadline_at timestamptz,
  question_ids uuid[] NOT NULL DEFAULT '{}',
  -- The board is derived from this seed and the run id, so a resumed run always shows the same committed board.
  server_seed text NOT NULL,
  score integer,
  settlement_reason text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  -- 'cancelled': returned untouched (play refunded) or cancelled by a block (no event).
  CONSTRAINT chk_partner_mines_runs_status CHECK (status IN ('active', 'cashed', 'lost', 'cancelled')),
  CONSTRAINT chk_partner_mines_runs_phase CHECK (phase IN ('picking', 'question', 'settled')),
  CONSTRAINT chk_partner_mines_runs_scouts CHECK (scouts_left BETWEEN 0 AND 3),
  CONSTRAINT chk_partner_mines_runs_score CHECK (score IS NULL OR score BETWEEN 0 AND 1000),
  CONSTRAINT chk_partner_mines_runs_settled CHECK ((status = 'active') = (phase <> 'settled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_mines_runs_active_player
  ON public.partner_mines_runs (player_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_partner_mines_runs_player_recent
  ON public.partner_mines_runs (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_mines_runs_active_seen
  ON public.partner_mines_runs (last_seen_at) WHERE status = 'active';

-- Every start id a player's client sent and the run it returned: a retried start (even one racing a settlement) gets
-- the same run back and never spends another play.
CREATE TABLE IF NOT EXISTS public.partner_game_starts (
  player_id uuid NOT NULL REFERENCES public.partner_players(id),
  game_id text NOT NULL,
  start_id text NOT NULL,
  run_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, game_id, start_id),
  CONSTRAINT chk_partner_game_starts_game CHECK (game_id IN ('road-to-goal', 'trivia-mines'))
);

-- Server-only (RLS without policies, no client grants): never reachable through the Data API.
ALTER TABLE public.partner_rtg_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_mines_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_game_starts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_rtg_runs, public.partner_mines_runs, public.partner_game_starts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.partner_rtg_runs, public.partner_mines_runs, public.partner_game_starts TO service_role;
