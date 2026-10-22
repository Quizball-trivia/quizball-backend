-- Portuguese (pt) becomes a locale: football_grid_attempts's locale check, widened NOT VALID (validated later under a weaker lock).
-- One table per migration: each runs in its own transaction, so no table's lock waits on another's.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.football_grid_attempts
  DROP CONSTRAINT IF EXISTS football_grid_attempts_locale_check,
  ADD CONSTRAINT football_grid_attempts_locale_check
    CHECK (locale IN ('en', 'ka', 'es', 'tr', 'ru', 'pt')) NOT VALID;
