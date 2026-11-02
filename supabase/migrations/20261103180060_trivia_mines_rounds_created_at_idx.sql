-- migrate:no-transaction
-- Time-window reads (HQ activity rollup refresh, admin-stats actives).
CREATE INDEX CONCURRENTLY IF NOT EXISTS trivia_mines_rounds_created_at_idx
  ON public.trivia_mines_rounds (created_at);
