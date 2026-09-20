-- migrate:no-transaction
-- Admin renames and the translation pool look answers up by player; the
-- existing index leads with board_id.
CREATE INDEX CONCURRENTLY IF NOT EXISTS football_grid_board_answers_player_only_idx
  ON public.football_grid_board_answers (football_player_id);
