-- A release may take a further alias set of a language after its first one (a supplement: "Frankreich", "Russland"),
-- pinned once like the first and never changed. The table holds a few dozen rows: rebuilding its key blocks nothing.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.tenable_alias_releases DROP CONSTRAINT IF EXISTS tenable_alias_releases_pkey;
ALTER TABLE public.tenable_alias_releases ADD CONSTRAINT tenable_alias_releases_pkey PRIMARY KEY (kind, release_id, locale, version);
