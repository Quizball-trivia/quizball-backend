SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- The validated check replaces the old one and takes its name (metadata only).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_partner_quiz_board_events_points_v2' AND conrelid = 'public.partner_quiz_board_events'::regclass) THEN
    ALTER TABLE public.partner_quiz_board_events DROP CONSTRAINT IF EXISTS chk_partner_quiz_board_events_points;
    ALTER TABLE public.partner_quiz_board_events RENAME CONSTRAINT chk_partner_quiz_board_events_points_v2 TO chk_partner_quiz_board_events_points;
  END IF;
END $$;
