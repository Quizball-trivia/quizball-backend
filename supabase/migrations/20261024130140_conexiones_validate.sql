SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '600s';

-- Validate after the ADD CONSTRAINT transactions have committed (SHARE UPDATE EXCLUSIVE: reads and writes go on). The
-- swaps are their own short migrations, so a blocked lock there never rolls these scans back. Each check is validated
-- only while it still has its new name (a database where the swap already ran has nothing left to validate).
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('room_pool', 'chk_room_pool_game_v7'),
    ('room_matches', 'chk_room_matches_game_v7'),
    ('lobbies', 'lobbies_room_game_check_v7')
  ) AS v(tbl, con) LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = c.con AND conrelid = format('public.%I', c.tbl)::regclass AND NOT convalidated) THEN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', c.tbl, c.con);
    END IF;
  END LOOP;
END $$;
