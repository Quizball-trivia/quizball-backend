SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '600s';

-- Validated after the ADD CONSTRAINT committed (one table per migration); only while the check still has its new name.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_partner_quiz_board_events_points_v2' AND conrelid = 'public.partner_quiz_board_events'::regclass AND NOT convalidated) THEN
    ALTER TABLE public.partner_quiz_board_events VALIDATE CONSTRAINT chk_partner_quiz_board_events_points_v2;
  END IF;
END $$;
