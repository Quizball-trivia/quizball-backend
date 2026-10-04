SET LOCAL lock_timeout = '5s';

-- Validate after the ADD CONSTRAINT transaction has committed (SHARE UPDATE EXCLUSIVE: reads and writes go on). The
-- ACCESS EXCLUSIVE swap of the old checks is its own short migration (20261003120002), so a blocked lock there never
-- rolls this scan back.
ALTER TABLE public.lobbies VALIDATE CONSTRAINT lobbies_duel_game_check_v3;
ALTER TABLE public.duel_pool VALIDATE CONSTRAINT chk_duel_pool_game_v3;
ALTER TABLE public.duel_matches VALIDATE CONSTRAINT chk_duel_matches_game_v3;
