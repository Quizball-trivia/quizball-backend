-- See 20261009190000: the validated wider cap takes the old one's name.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_shared_player_runs_speed_v2' AND conrelid = 'public.shared_player_runs'::regclass AND convalidated) THEN
    ALTER TABLE public.shared_player_runs DROP CONSTRAINT IF EXISTS chk_shared_player_runs_speed;
    ALTER TABLE public.shared_player_runs RENAME CONSTRAINT chk_shared_player_runs_speed_v2 TO chk_shared_player_runs_speed;
  END IF;
END $$;
