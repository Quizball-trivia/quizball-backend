SET LOCAL lock_timeout = '5s';

-- Validate after the ADD CONSTRAINT transaction has committed, so the table scan does not run while that migration's
-- ACCESS EXCLUSIVE lock is held. The swap of the old mode check is the next migration, so its lock stays brief.
ALTER TABLE public.lobbies VALIDATE CONSTRAINT lobbies_game_mode_check_v4;
ALTER TABLE public.lobbies VALIDATE CONSTRAINT lobbies_room_game_check;
