SET LOCAL lock_timeout = '5s';

-- Validate after the ADD CONSTRAINT transaction has committed (SHARE UPDATE EXCLUSIVE: reads and writes go on). The
-- ACCESS EXCLUSIVE swap of the old checks is its own short migration (20261008120102), so a blocked lock there never
-- rolls this scan back.
ALTER TABLE public.lobbies VALIDATE CONSTRAINT lobbies_room_game_check_v2;
ALTER TABLE public.lobbies VALIDATE CONSTRAINT lobbies_room_options_check;
ALTER TABLE public.room_pool VALIDATE CONSTRAINT chk_room_pool_game_v2;
ALTER TABLE public.room_matches VALIDATE CONSTRAINT chk_room_matches_game_v2;
