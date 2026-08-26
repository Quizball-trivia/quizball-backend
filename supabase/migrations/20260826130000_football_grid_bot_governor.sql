-- Football Tic Tac Toe v2 match pin. Keep this hot-table migration short:
-- PostgreSQL holds the ALTER lock until transaction commit.

-- Fail the deploy cleanly instead of waiting behind a long-lived transaction.
SET lock_timeout = '5s';

ALTER TABLE public.football_grid_matches
  ADD COLUMN IF NOT EXISTS bot_strength_adjustment numeric(6,4);

-- NOT VALID avoids scanning the hot match table during the deploy. PostgreSQL
-- still enforces the constraint for every new/updated row.
DO $$
BEGIN
  ALTER TABLE public.football_grid_matches
    ADD CONSTRAINT football_grid_matches_bot_strength_adjustment_check
    CHECK (
      bot_strength_adjustment IS NULL
      OR bot_strength_adjustment BETWEEN -0.2000 AND 0.0000
    ) NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

COMMENT ON COLUMN public.football_grid_matches.bot_strength_adjustment IS
  'Grid-only governor adjustment pinned at match creation; v2 requires [-0.20, 0], v1 ignores it.';

RESET lock_timeout;
