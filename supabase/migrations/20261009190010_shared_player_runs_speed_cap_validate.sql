-- See 20261009190000: validates the wider tie-break cap (a scan under SHARE UPDATE EXCLUSIVE; writes go on).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_shared_player_runs_speed_v2' AND conrelid = 'public.shared_player_runs'::regclass AND NOT convalidated) THEN
    ALTER TABLE public.shared_player_runs VALIDATE CONSTRAINT chk_shared_player_runs_speed_v2;
  END IF;
END $$;
