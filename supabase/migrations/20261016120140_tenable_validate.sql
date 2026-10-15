SET LOCAL lock_timeout = '5s';

-- Validate after the ADD CONSTRAINT transactions have committed. SHARE UPDATE EXCLUSIVE: reads and writes go on, so
-- holding it on several tables at once conflicts with no game transaction. The swaps are their own short migrations.
ALTER TABLE public.room_pool VALIDATE CONSTRAINT chk_room_pool_game_v3;
ALTER TABLE public.room_matches VALIDATE CONSTRAINT chk_room_matches_game_v3;
ALTER TABLE public.lobbies VALIDATE CONSTRAINT lobbies_room_game_check_v3;
ALTER TABLE public.wordgame_reports VALIDATE CONSTRAINT chk_wordgame_reports_game_v2;
