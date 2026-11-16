-- Greek (el) becomes a locale: lobby_members's locale check, widened NOT VALID (validated later under a weaker lock).
-- One table per migration: each runs in its own transaction, so no table's lock waits on another's.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.lobby_members
  DROP CONSTRAINT IF EXISTS lobby_members_locale_check,
  ADD CONSTRAINT lobby_members_locale_check
    CHECK (locale IS NULL OR locale IN ('en', 'es', 'ka', 'tr', 'ru', 'pt', 'de', 'fr', 'el')) NOT VALID;
