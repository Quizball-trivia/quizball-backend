-- Separate transaction from the CHECK replacements: validation takes a weaker lock.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.tenable_list_text VALIDATE CONSTRAINT tenable_list_text_locale_check;
ALTER TABLE public.tenable_alias_sets VALIDATE CONSTRAINT tenable_alias_sets_locale_check;
ALTER TABLE public.tenable_alias_releases VALIDATE CONSTRAINT tenable_alias_releases_locale_check;
