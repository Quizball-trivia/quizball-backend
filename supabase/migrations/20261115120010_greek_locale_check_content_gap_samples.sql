-- Greek (el) becomes a locale: content_gap_samples's locale check, widened NOT VALID (validated later under a weaker lock).
-- One table per migration: each runs in its own transaction, so no table's lock waits on another's.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.content_gap_samples
  DROP CONSTRAINT IF EXISTS chk_content_gap_samples_locale,
  ADD CONSTRAINT chk_content_gap_samples_locale
    CHECK (locale IN ('es', 'en', 'ka', 'tr', 'ru', 'pt', 'de', 'fr', 'xx', 'el')) NOT VALID;
