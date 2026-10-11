-- Tic Tac Toe board difficulty from real play. A board's own `difficulty` is set by the content generator from
-- how famous its answers are and cannot change once published. These two tables hold what players actually
-- manage: football_grid_criterion_stats is the share of typed answers that were right for each category, and
-- football_grid_board_difficulty is every published board's score, the label that score suggests, and the label
-- a reviewer applied. Board selection reads `applied` in place of the content label when it is set.
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.football_grid_criterion_stats (
  criterion_key text PRIMARY KEY,
  family text NOT NULL,
  answers integer NOT NULL,
  correct integer NOT NULL,
  -- Smoothed toward the family's rate, so a category seen a handful of times does not swing to 0 or 1.
  rate numeric(5,4) NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_football_grid_criterion_stats_counts CHECK (answers >= 0 AND correct BETWEEN 0 AND answers),
  CONSTRAINT chk_football_grid_criterion_stats_rate CHECK (rate BETWEEN 0 AND 1)
);

CREATE TABLE IF NOT EXISTS public.football_grid_board_difficulty (
  board_id uuid PRIMARY KEY REFERENCES public.football_grid_boards(id) ON DELETE CASCADE,
  answers integer NOT NULL,
  correct integer NOT NULL,
  -- What the categories on the board predict, before any play on this board.
  predicted_rate numeric(5,4) NOT NULL,
  -- The board's difficulty score: its own answers blended with the prediction.
  score numeric(5,4) NOT NULL,
  weakest_cell_index smallint NOT NULL,
  weakest_cell_rate numeric(5,4) NOT NULL,
  basis text NOT NULL,
  suggested text NOT NULL,
  verdict text NOT NULL,
  -- [{cell, answers, correct, predicted, rate}] x9.
  cells jsonb NOT NULL,
  applied text,
  applied_by text,
  applied_at timestamptz,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_football_grid_board_difficulty_counts CHECK (answers >= 0 AND correct BETWEEN 0 AND answers),
  CONSTRAINT chk_football_grid_board_difficulty_rates CHECK (
    predicted_rate BETWEEN 0 AND 1 AND score BETWEEN 0 AND 1 AND weakest_cell_rate BETWEEN 0 AND 1
  ),
  CONSTRAINT chk_football_grid_board_difficulty_weakest CHECK (weakest_cell_index BETWEEN 0 AND 8),
  CONSTRAINT chk_football_grid_board_difficulty_basis CHECK (basis IN ('measured', 'predicted')),
  CONSTRAINT chk_football_grid_board_difficulty_suggested CHECK (suggested IN ('easy', 'normal', 'hard')),
  CONSTRAINT chk_football_grid_board_difficulty_verdict CHECK (verdict IN ('keep', 'move', 'retire')),
  CONSTRAINT chk_football_grid_board_difficulty_applied CHECK (applied IS NULL OR applied IN ('easy', 'normal', 'hard')),
  CONSTRAINT chk_football_grid_board_difficulty_applied_by CHECK ((applied IS NULL) = (applied_at IS NULL)),
  CONSTRAINT chk_football_grid_board_difficulty_cells CHECK (jsonb_typeof(cells) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_football_grid_board_difficulty_verdict
  ON public.football_grid_board_difficulty (verdict, score);

ALTER TABLE public.football_grid_criterion_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_board_difficulty ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.football_grid_criterion_stats, public.football_grid_board_difficulty FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.football_grid_criterion_stats, public.football_grid_board_difficulty TO service_role;
