-- Separate transaction from the CHECK replacements: validation takes a weaker lock.
-- tenable_list_text stays pt/de/fr: Spanish titles and notes are part of every list.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.tenable_alias_sets VALIDATE CONSTRAINT tenable_alias_sets_locale_check;
ALTER TABLE public.tenable_alias_releases VALIDATE CONSTRAINT tenable_alias_releases_locale_check;
ALTER TABLE public.tenable_display_names VALIDATE CONSTRAINT tenable_display_names_locale_check;
