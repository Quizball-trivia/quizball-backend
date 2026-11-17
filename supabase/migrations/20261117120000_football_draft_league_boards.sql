-- Football Draft: the player picks the league and every league keeps a weekly board of free runs. A run is ranked when a
-- member starts it on the board's rules; it lands on the board of its league and its week (Monday, Buenos Aires days)
-- when it is finished. New columns are nullable or carry a constant default, so this is a catalogue change only. The
-- checks are added NOT VALID and validated in 20261117120010.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.draft_free_runs
  ADD COLUMN IF NOT EXISTS ranked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS league_id text,
  ADD COLUMN IF NOT EXISTS week date,
  -- Wins, draws, losses, shown on the board (w * 10000 + d * 100 + l, as the daily runs store it).
  ADD COLUMN IF NOT EXISTS record integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_draft_free_runs_ranked' AND conrelid = 'public.draft_free_runs'::regclass) THEN
    ALTER TABLE public.draft_free_runs ADD CONSTRAINT chk_draft_free_runs_ranked CHECK (NOT ranked OR (user_id IS NOT NULL AND kind = 'free')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_draft_free_runs_board' AND conrelid = 'public.draft_free_runs'::regclass) THEN
    ALTER TABLE public.draft_free_runs ADD CONSTRAINT chk_draft_free_runs_board
      CHECK (NOT (ranked AND done) OR (league_id IS NOT NULL AND week IS NOT NULL AND score IS NOT NULL AND record IS NOT NULL)) NOT VALID;
  END IF;
END $$;
