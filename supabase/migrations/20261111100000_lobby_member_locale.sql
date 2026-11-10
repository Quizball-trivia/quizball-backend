-- A room member's interface language at the moment they pressed Ready. Room games that deal content by audience
-- (Tenable lists) read it when the host starts; NULL when unknown (older clients). The check is added NOT VALID and
-- validated in the next migration, so this hot table is not scanned under an exclusive lock.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.lobby_members ADD COLUMN IF NOT EXISTS locale text;
ALTER TABLE public.lobby_members
  DROP CONSTRAINT IF EXISTS lobby_members_locale_check,
  ADD CONSTRAINT lobby_members_locale_check CHECK (locale IS NULL OR locale IN ('en', 'es', 'ka', 'tr', 'ru', 'pt', 'de', 'fr')) NOT VALID;
