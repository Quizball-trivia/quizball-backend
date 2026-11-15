-- Greek (el) becomes a locale: campaign_quiz_slugs's locale check, widened NOT VALID (validated later under a weaker lock).
-- One table per migration: each runs in its own transaction, so no table's lock waits on another's.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.campaign_quiz_slugs
  DROP CONSTRAINT IF EXISTS campaign_quiz_slugs_locale_check,
  ADD CONSTRAINT campaign_quiz_slugs_locale_check
    CHECK (locale IN ('en', 'ka', 'es', 'ru', 'pt', 'de', 'tr', 'fr', 'el')) NOT VALID;
