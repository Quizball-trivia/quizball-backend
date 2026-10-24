-- German (de) joins Portuguese in tenable_alias_sets: the locale check widened NOT VALID (validated in the next migration).
-- One table per migration: each runs in its own transaction, so no table's lock waits on another's.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.tenable_alias_sets
  DROP CONSTRAINT IF EXISTS tenable_alias_sets_locale_check,
  ADD CONSTRAINT tenable_alias_sets_locale_check CHECK (locale IN ('pt', 'de')) NOT VALID;
