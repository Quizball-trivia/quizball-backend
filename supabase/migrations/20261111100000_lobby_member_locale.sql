-- A room member's interface language at the moment they pressed Ready. Room games that deal content by audience
-- (Tenable lists) read it when the host starts; NULL for old clients that do not send it.
ALTER TABLE public.lobby_members ADD COLUMN IF NOT EXISTS locale text
  CHECK (locale IS NULL OR locale IN ('en', 'es', 'ka', 'tr', 'ru', 'pt', 'de', 'fr'));
