-- The board hints (samples and recognizable ranks) that order a judge version's cells, copied into the version while
-- it builds. Published board answers still accept inserts, so reading them live (even with a time cutoff) could
-- reorder a sealed version; the copy is sealed with everything else. Server-only, like the other judge tables.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.football_grid_judge_board_hints (
  judge_version_id uuid NOT NULL REFERENCES public.football_grid_judge_versions(id) ON DELETE RESTRICT,
  board_id uuid NOT NULL REFERENCES public.football_grid_boards(id) ON DELETE RESTRICT,
  cell_index smallint NOT NULL CHECK (cell_index BETWEEN 0 AND 8),
  football_player_id uuid NOT NULL REFERENCES public.football_players(id) ON DELETE RESTRICT,
  is_sample boolean NOT NULL,
  recognizable_rank integer CHECK (recognizable_rank IS NULL OR recognizable_rank > 0),
  PRIMARY KEY (judge_version_id, board_id, cell_index, football_player_id),
  CHECK (is_sample OR recognizable_rank IS NOT NULL)
);

CREATE TRIGGER football_grid_judge_board_hints_guard BEFORE INSERT OR UPDATE OR DELETE ON public.football_grid_judge_board_hints
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_judge_content_guard();

ALTER TABLE public.football_grid_judge_board_hints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.football_grid_judge_board_hints FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.football_grid_judge_board_hints TO service_role;
