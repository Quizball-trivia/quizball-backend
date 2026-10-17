-- Russian (ru) becomes a public locale: football_player_name_translations's locale check, widened NOT VALID (validated later under a weaker lock).
-- One table per migration: each runs in its own transaction, so no table's lock waits on another's.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.football_player_name_translations
  DROP CONSTRAINT IF EXISTS football_player_name_translations_locale_check,
  ADD CONSTRAINT football_player_name_translations_locale_check
    CHECK (locale IN ('ka', 'ru')) NOT VALID;
