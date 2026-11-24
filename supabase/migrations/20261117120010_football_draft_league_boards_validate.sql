SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '600s';

-- Validate after 20261117120000 has committed (SHARE UPDATE EXCLUSIVE: reads and writes go on).
DO $$
DECLARE
  con text;
BEGIN
  FOREACH con IN ARRAY ARRAY['chk_draft_free_runs_ranked', 'chk_draft_free_runs_board'] LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = con AND conrelid = 'public.draft_free_runs'::regclass AND NOT convalidated) THEN
      EXECUTE format('ALTER TABLE public.draft_free_runs VALIDATE CONSTRAINT %I', con);
    END IF;
  END LOOP;
END $$;
