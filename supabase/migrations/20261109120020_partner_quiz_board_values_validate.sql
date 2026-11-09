SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '600s';

-- Validated after the ADD CONSTRAINTs committed; each only while it still has its new name.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('partner_quiz_board_tiles', 'chk_partner_quiz_board_tiles_difficulty_v2'),
    ('partner_quiz_board_events', 'chk_partner_quiz_board_events_points_v2')
  ) AS v(tbl, con) LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.con AND conrelid = format('public.%I', c.tbl)::regclass AND NOT convalidated) THEN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', c.tbl, c.con);
    END IF;
  END LOOP;
END $$;
