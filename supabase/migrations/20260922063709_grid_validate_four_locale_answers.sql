-- Separate transaction from the CHECK replacement: validation allows gameplay writes.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.football_grid_command_inbox VALIDATE CONSTRAINT football_grid_command_inbox_locale_check;
ALTER TABLE public.football_grid_attempts VALIDATE CONSTRAINT football_grid_attempts_locale_check;
ALTER TABLE public.football_grid_claims VALIDATE CONSTRAINT football_grid_claims_submitted_locale_check;
ALTER TABLE public.football_grid_player_aliases VALIDATE CONSTRAINT football_grid_player_aliases_locale_check;
