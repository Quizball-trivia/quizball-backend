-- A pick-from-four answer names its footballer by id as well as by name, so the pick is judged as that footballer
-- whatever two names look alike. NULL for every typed answer.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.football_grid_command_inbox ADD COLUMN IF NOT EXISTS option_player_id uuid;
