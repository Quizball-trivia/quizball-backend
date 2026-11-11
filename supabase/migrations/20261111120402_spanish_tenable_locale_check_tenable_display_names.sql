-- Spanish (es) joins Portuguese, German and French in tenable_display_names: the locale check widened NOT VALID (validated in the next migration).
-- One table per migration: each runs in its own transaction, so no table's lock waits on another's.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.tenable_display_names
  DROP CONSTRAINT IF EXISTS tenable_display_names_locale_check,
  ADD CONSTRAINT tenable_display_names_locale_check CHECK (locale IN ('pt', 'de', 'fr', 'es')) NOT VALID;
