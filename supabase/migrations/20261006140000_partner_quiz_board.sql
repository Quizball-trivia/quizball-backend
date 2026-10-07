-- Quiz Board for Freecroco (contract §7.7): one board per partner play, its 9 tiles with the question snapshot and
-- the AI's seeded decisions, and the ordered log of every move (the web view animates the AI's turns from it).
-- State machine: src/modules/partners/games/quiz-board/quiz-board.machine.ts.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.partner_quiz_boards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  play_id uuid NOT NULL UNIQUE REFERENCES public.partner_plays(id),
  partner_player_id uuid NOT NULL REFERENCES public.partner_players(id),
  seed text NOT NULL,
  -- [{ "id": uuid, "name": { "en": ..., "ka": ... } }] × 3, in column order
  categories jsonb NOT NULL,
  phase text NOT NULL DEFAULT 'pick',
  active_tile smallint,
  turn integer NOT NULL DEFAULT 0,
  opens_at timestamptz,
  deadline_at timestamptz,
  player_score integer NOT NULL DEFAULT 0,
  ai_score integer NOT NULL DEFAULT 0,
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT chk_partner_quiz_boards_phase CHECK (phase IN ('pick', 'answer', 'steal', 'ending', 'finished')),
  CONSTRAINT chk_partner_quiz_boards_active CHECK ((phase IN ('answer', 'steal')) = (active_tile IS NOT NULL)),
  CONSTRAINT chk_partner_quiz_boards_tile CHECK (active_tile IS NULL OR active_tile BETWEEN 0 AND 8),
  CONSTRAINT chk_partner_quiz_boards_deadline CHECK ((phase = 'finished') = (deadline_at IS NULL)),
  CONSTRAINT chk_partner_quiz_boards_finished
    CHECK ((phase = 'finished') = (finished_at IS NOT NULL AND end_reason IS NOT NULL)),
  CONSTRAINT chk_partner_quiz_boards_end_reason
    CHECK (end_reason IS NULL OR end_reason IN ('completed', 'left', 'idle', 'cancelled')),
  CONSTRAINT chk_partner_quiz_boards_scores
    CHECK (player_score BETWEEN 0 AND 1800 AND ai_score BETWEEN 0 AND 1800 AND player_score + ai_score <= 1800)
);
-- At most one unfinished board per player: a second start resumes it instead of taking another play.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_quiz_boards_open
  ON public.partner_quiz_boards (partner_player_id) WHERE phase <> 'finished';
CREATE INDEX IF NOT EXISTS idx_partner_quiz_boards_player ON public.partner_quiz_boards (partner_player_id);
-- The sweeper's scan.
CREATE INDEX IF NOT EXISTS idx_partner_quiz_boards_due
  ON public.partner_quiz_boards (deadline_at) WHERE phase <> 'finished';

CREATE TABLE IF NOT EXISTS public.partner_quiz_board_tiles (
  board_id uuid NOT NULL REFERENCES public.partner_quiz_boards(id) ON DELETE CASCADE,
  tile smallint NOT NULL,
  -- Snapshot at draw time, so a CMS edit during a play cannot change the question or its answer.
  question_id uuid NOT NULL,
  difficulty text NOT NULL,
  value integer NOT NULL,
  prompt jsonb NOT NULL,
  options jsonb NOT NULL,
  image jsonb,
  correct_index smallint NOT NULL,
  ai_rank smallint NOT NULL,
  ai_correct boolean NOT NULL,
  ai_steal_correct boolean NOT NULL,
  owner text,
  used_at timestamptz,
  PRIMARY KEY (board_id, tile),
  CONSTRAINT chk_partner_quiz_board_tiles_tile CHECK (tile BETWEEN 0 AND 8),
  CONSTRAINT chk_partner_quiz_board_tiles_difficulty CHECK (
    (difficulty, value) IN (('easy', 100), ('medium', 200), ('hard', 300))
  ),
  CONSTRAINT chk_partner_quiz_board_tiles_options CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) = 4),
  CONSTRAINT chk_partner_quiz_board_tiles_correct CHECK (correct_index BETWEEN 0 AND 3),
  CONSTRAINT chk_partner_quiz_board_tiles_rank CHECK (ai_rank BETWEEN 0 AND 8),
  CONSTRAINT chk_partner_quiz_board_tiles_owner CHECK (owner IS NULL OR owner IN ('player', 'ai', 'none')),
  CONSTRAINT chk_partner_quiz_board_tiles_used CHECK ((owner IS NULL) = (used_at IS NULL))
);
-- A player's earlier boards are excluded when drawing a new one.
CREATE INDEX IF NOT EXISTS idx_partner_quiz_board_tiles_question ON public.partner_quiz_board_tiles (question_id);

CREATE TABLE IF NOT EXISTS public.partner_quiz_board_events (
  board_id uuid NOT NULL REFERENCES public.partner_quiz_boards(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  actor text NOT NULL,
  kind text NOT NULL,
  tile smallint,
  correct boolean,
  choice smallint,
  points integer NOT NULL DEFAULT 0,
  at timestamptz NOT NULL,
  PRIMARY KEY (board_id, seq),
  CONSTRAINT chk_partner_quiz_board_events_actor CHECK (actor IN ('player', 'ai', 'system')),
  CONSTRAINT chk_partner_quiz_board_events_kind
    CHECK (kind IN ('pick', 'answer', 'timeout', 'ai_steal', 'ai_answer', 'end')),
  CONSTRAINT chk_partner_quiz_board_events_choice CHECK (choice IS NULL OR choice BETWEEN 0 AND 3),
  CONSTRAINT chk_partner_quiz_board_events_points CHECK (points IN (0, 100, 200, 300))
);

-- Every start id that returned a board (it created the play, resumed an open board or lost a race to one): a retry
-- of the same start always gets that play back and never takes another.
CREATE TABLE IF NOT EXISTS public.partner_quiz_board_starts (
  partner_player_id uuid NOT NULL REFERENCES public.partner_players(id),
  start_id text NOT NULL,
  play_id uuid NOT NULL REFERENCES public.partner_quiz_boards(play_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_player_id, start_id)
);
CREATE INDEX IF NOT EXISTS idx_partner_quiz_board_starts_play ON public.partner_quiz_board_starts (play_id);

-- Server-only (RLS without policies, no client grants), like the partner core tables.
ALTER TABLE public.partner_quiz_boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_quiz_board_tiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_quiz_board_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_quiz_board_starts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_quiz_boards, public.partner_quiz_board_tiles, public.partner_quiz_board_events,
  public.partner_quiz_board_starts FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.partner_quiz_boards, public.partner_quiz_board_tiles, public.partner_quiz_board_events,
  public.partner_quiz_board_starts TO service_role;
