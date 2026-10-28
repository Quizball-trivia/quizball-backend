SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '600s';

-- Validated after the ADD CONSTRAINT committed (SHARE UPDATE EXCLUSIVE: reads and writes go on); only while the check
-- still has its new name (a database where the swap already ran has nothing left to validate).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_partner_games_game_v2' AND conrelid = 'public.partner_games'::regclass AND NOT convalidated) THEN
    ALTER TABLE public.partner_games VALIDATE CONSTRAINT chk_partner_games_game_v2;
  END IF;
END $$;
