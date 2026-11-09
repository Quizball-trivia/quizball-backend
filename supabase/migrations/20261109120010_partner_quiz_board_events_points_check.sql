-- See 20261109120000: an answer event carries its tile's value, old or new.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_partner_quiz_board_events_points_v2' AND conrelid = 'public.partner_quiz_board_events'::regclass) THEN
    ALTER TABLE public.partner_quiz_board_events ADD CONSTRAINT chk_partner_quiz_board_events_points_v2
      CHECK (points IN (0, 50, 100, 150, 200, 300)) NOT VALID;
  END IF;
END $$;
