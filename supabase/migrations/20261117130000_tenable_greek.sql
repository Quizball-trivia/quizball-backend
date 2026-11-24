-- Football Tenable and Football Darts 501 in Greek, exactly like Russian (20261016130600_tenable_russian.sql). New, empty
-- tables: the plain index builds block nothing. The names themselves are loaded per environment, never by a migration.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Greek names of managers, clubs and national teams by entity id (Wikidata ids, shared by every entity release), in
-- immutable sets. Players take theirs from the word games' versions (wordgame_el_names).
CREATE TABLE IF NOT EXISTS public.tenable_el_name_sets (
  version text PRIMARY KEY CHECK (version ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  fingerprint text NOT NULL,
  entities integer NOT NULL CHECK (entities > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tenable_el_names (
  version text NOT NULL REFERENCES public.tenable_el_name_sets(version) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('manager', 'club', 'nation')),
  eid text NOT NULL CHECK (length(eid) BETWEEN 1 AND 64),
  name_el text NOT NULL CHECK (length(name_el) BETWEEN 1 AND 80),
  known_el text NOT NULL CHECK (length(known_el) BETWEEN 1 AND 80),
  aliases_el text[] NOT NULL DEFAULT '{}' CHECK (cardinality(aliases_el) <= 24 AND array_position(aliases_el, NULL) IS NULL),
  qualifier_el text CHECK (qualifier_el IS NULL OR length(qualifier_el) BETWEEN 1 AND 60),
  PRIMARY KEY (version, kind, eid)
);

-- The Greek names an entity release is judged with, written once and never changed: a Greek answer then means the same
-- entity for as long as the release is played. Written only when every entity of the release has a Greek name (a
-- partial set would make "this Greek name is known" depend on the list).
CREATE TABLE IF NOT EXISTS public.tenable_el_releases (
  kind text NOT NULL CHECK (kind IN ('player', 'manager', 'club', 'nation')),
  release_id text NOT NULL CHECK (length(release_id) BETWEEN 1 AND 64),
  players_version text REFERENCES public.wordgame_el_versions(version) ON DELETE RESTRICT,
  names_version text REFERENCES public.tenable_el_name_sets(version) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, release_id),
  CONSTRAINT chk_tenable_el_releases_source CHECK (
    CASE WHEN kind = 'player' THEN players_version IS NOT NULL AND names_version IS NULL
         ELSE names_version IS NOT NULL AND players_version IS NULL END)
);

CREATE OR REPLACE FUNCTION public.tenable_el_releases_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'tenable_el_releases rows are written once (a release keeps its Greek names)';
END $$;
DROP TRIGGER IF EXISTS tenable_el_releases_immutable ON public.tenable_el_releases;
CREATE TRIGGER tenable_el_releases_immutable BEFORE UPDATE OR DELETE ON public.tenable_el_releases
  FOR EACH ROW EXECUTE FUNCTION public.tenable_el_releases_immutable();

-- A set of names is written once, with its set row, and never changed: a pinned release keeps exactly the names it was
-- checked with.
CREATE OR REPLACE FUNCTION public.tenable_el_names_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- now() is the transaction's start: only the transaction that created the set may add to it.
    IF (SELECT created_at FROM public.tenable_el_name_sets WHERE version = NEW.version) = now() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Tenable Greek names are written only with their set';
  END IF;
  RAISE EXCEPTION 'Tenable Greek names never change';
END $$;
DROP TRIGGER IF EXISTS tenable_el_names_immutable ON public.tenable_el_names;
CREATE TRIGGER tenable_el_names_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.tenable_el_names
  FOR EACH ROW EXECUTE FUNCTION public.tenable_el_names_immutable();
REVOKE ALL ON FUNCTION public.tenable_el_names_immutable() FROM PUBLIC, anon, authenticated;

-- A set's row never changes: its creation time decides which transaction may add names to it.
CREATE OR REPLACE FUNCTION public.tenable_el_name_sets_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Tenable Greek name sets never change';
END $$;
DROP TRIGGER IF EXISTS tenable_el_name_sets_immutable ON public.tenable_el_name_sets;
CREATE TRIGGER tenable_el_name_sets_immutable BEFORE UPDATE ON public.tenable_el_name_sets
  FOR EACH ROW EXECUTE FUNCTION public.tenable_el_name_sets_immutable();
REVOKE ALL ON FUNCTION public.tenable_el_name_sets_immutable() FROM PUBLIC, anon, authenticated;

-- Server-only like the lists: names pinned to a release say which entities a future day may hold.
ALTER TABLE public.tenable_el_name_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenable_el_names ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenable_el_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenable_el_name_sets, public.tenable_el_names, public.tenable_el_releases FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tenable_el_name_sets, public.tenable_el_names, public.tenable_el_releases TO service_role;
REVOKE ALL ON FUNCTION public.tenable_el_releases_immutable() FROM PUBLIC, anon, authenticated;
