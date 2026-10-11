-- A closed day's answers are public, so no board, and no content under another release's id, may serve two days:
-- yesterday's review would otherwise show today's answers. The seed script already avoids it; this enforces it.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE UNIQUE INDEX IF NOT EXISTS uq_grid_daily_days_board_id
  ON public.grid_daily_days ((board->>'boardId'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_grid_daily_days_board_checksum
  ON public.grid_daily_days ((board->>'checksum'))
  WHERE board->>'checksum' IS NOT NULL;
