-- Expand the locale checks without scanning live gameplay tables under an exclusive lock.
-- The following migration validates these checks under a weaker lock.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.football_grid_command_inbox
  DROP CONSTRAINT IF EXISTS football_grid_command_inbox_locale_check,
  ADD CONSTRAINT football_grid_command_inbox_locale_check
    CHECK (locale IN ('en', 'ka', 'es', 'tr')) NOT VALID;

ALTER TABLE public.football_grid_attempts
  DROP CONSTRAINT IF EXISTS football_grid_attempts_locale_check,
  ADD CONSTRAINT football_grid_attempts_locale_check
    CHECK (locale IN ('en', 'ka', 'es', 'tr')) NOT VALID;

ALTER TABLE public.football_grid_claims
  DROP CONSTRAINT IF EXISTS football_grid_claims_submitted_locale_check,
  ADD CONSTRAINT football_grid_claims_submitted_locale_check
    CHECK (submitted_locale IN ('en', 'ka', 'es', 'tr')) NOT VALID;

ALTER TABLE public.football_grid_player_aliases
  DROP CONSTRAINT IF EXISTS football_grid_player_aliases_locale_check,
  ADD CONSTRAINT football_grid_player_aliases_locale_check
    CHECK (locale IN ('en', 'ka', 'es', 'tr', 'translit')) NOT VALID;
