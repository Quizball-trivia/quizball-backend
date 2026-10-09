-- "Played for both" daily: twenty seconds per pair from 2026-10-10. The tie-break is the tenths of a second left over
-- the pairs found, so ten pairs can add up to 2000 (the cap was 10 pairs x 100 tenths). Three migrations, each its own
-- transaction: adding the new check takes the table's exclusive lock only for an instant (NOT VALID), validating it
-- scans without blocking writes, and the swap is again instant.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_shared_player_runs_speed_v2' AND conrelid = 'public.shared_player_runs'::regclass)
     AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_shared_player_runs_speed' AND conrelid = 'public.shared_player_runs'::regclass
                 AND pg_get_constraintdef(oid) NOT LIKE '%2000%') THEN
    ALTER TABLE public.shared_player_runs ADD CONSTRAINT chk_shared_player_runs_speed_v2 CHECK (speed BETWEEN 0 AND 2000) NOT VALID;
  END IF;
END $$;
