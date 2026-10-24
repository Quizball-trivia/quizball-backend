-- German (de) joins Portuguese in tenable_list_text: the locale check widened NOT VALID (validated in the next migration).
-- One table per migration: each runs in its own transaction, so no table's lock waits on another's.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.tenable_list_text
  DROP CONSTRAINT IF EXISTS tenable_list_text_locale_check,
  ADD CONSTRAINT tenable_list_text_locale_check CHECK (locale IN ('pt', 'de')) NOT VALID;
