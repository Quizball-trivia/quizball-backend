-- Football Tenable answers in further Latin-script languages (pt first): extra spellings of clubs and national teams
-- ("Alemanha", "Bayern de Munique") added to an entity release's Latin directory, as the Spanish ones already are.
-- New, empty tables: the plain index builds block nothing.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Spellings by entity id (Wikidata ids, shared by every entity release), in immutable sets of one language.
CREATE TABLE IF NOT EXISTS public.tenable_alias_sets (
  version text PRIMARY KEY CHECK (version ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  locale text NOT NULL CHECK (locale IN ('pt')),
  fingerprint text NOT NULL,
  entities integer NOT NULL CHECK (entities > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tenable_aliases (
  version text NOT NULL REFERENCES public.tenable_alias_sets(version) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('club', 'nation')),
  eid text NOT NULL CHECK (length(eid) BETWEEN 1 AND 64),
  aliases text[] NOT NULL CHECK (cardinality(aliases) BETWEEN 1 AND 12),
  PRIMARY KEY (version, kind, eid)
);

-- The alias set an entity release is judged with in one language, written once and never changed: a typed answer then
-- means the same entity for as long as the release is played. Written only after every list of the release was
-- re-checked with the extra spellings (scripts/tenable-pt-aliases.ts pin).
CREATE TABLE IF NOT EXISTS public.tenable_alias_releases (
  kind text NOT NULL CHECK (kind IN ('club', 'nation')),
  release_id text NOT NULL CHECK (length(release_id) BETWEEN 1 AND 64),
  locale text NOT NULL CHECK (locale IN ('pt')),
  version text NOT NULL REFERENCES public.tenable_alias_sets(version) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, release_id, locale)
);

CREATE OR REPLACE FUNCTION public.tenable_alias_releases_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'tenable_alias_releases rows are written once (a release keeps its spellings)';
END $$;
DROP TRIGGER IF EXISTS tenable_alias_releases_immutable ON public.tenable_alias_releases;
CREATE TRIGGER tenable_alias_releases_immutable BEFORE UPDATE OR DELETE ON public.tenable_alias_releases
  FOR EACH ROW EXECUTE FUNCTION public.tenable_alias_releases_immutable();
REVOKE ALL ON FUNCTION public.tenable_alias_releases_immutable() FROM PUBLIC, anon, authenticated;

-- A set's spellings are written once, with its set row, and never changed.
CREATE OR REPLACE FUNCTION public.tenable_aliases_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- now() is the transaction's start: only the transaction that created the set may add to it.
    IF (SELECT created_at FROM public.tenable_alias_sets WHERE version = NEW.version) = now() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Tenable aliases are written only with their set';
  END IF;
  RAISE EXCEPTION 'Tenable aliases never change';
END $$;
DROP TRIGGER IF EXISTS tenable_aliases_immutable ON public.tenable_aliases;
CREATE TRIGGER tenable_aliases_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.tenable_aliases
  FOR EACH ROW EXECUTE FUNCTION public.tenable_aliases_immutable();
REVOKE ALL ON FUNCTION public.tenable_aliases_immutable() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.tenable_alias_sets_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Tenable alias sets never change';
END $$;
DROP TRIGGER IF EXISTS tenable_alias_sets_immutable ON public.tenable_alias_sets;
CREATE TRIGGER tenable_alias_sets_immutable BEFORE UPDATE OR DELETE ON public.tenable_alias_sets
  FOR EACH ROW EXECUTE FUNCTION public.tenable_alias_sets_immutable();
REVOKE ALL ON FUNCTION public.tenable_alias_sets_immutable() FROM PUBLIC, anon, authenticated;

-- Server-only like the lists.
ALTER TABLE public.tenable_alias_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenable_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenable_alias_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenable_alias_sets, public.tenable_aliases, public.tenable_alias_releases FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tenable_alias_sets, public.tenable_aliases, public.tenable_alias_releases TO service_role;
