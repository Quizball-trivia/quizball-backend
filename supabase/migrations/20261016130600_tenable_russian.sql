-- Football Tenable in Russian. New, empty tables: the plain index builds block nothing.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- Russian names of managers, clubs and national teams by entity id (Wikidata ids, shared by every entity release),
-- in immutable sets. Players take theirs from the word games' versions (wordgame_ru_names).
CREATE TABLE IF NOT EXISTS public.tenable_ru_name_sets (
  version text PRIMARY KEY CHECK (version ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  fingerprint text NOT NULL,
  entities integer NOT NULL CHECK (entities > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tenable_ru_names (
  version text NOT NULL REFERENCES public.tenable_ru_name_sets(version) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('manager', 'club', 'nation')),
  eid text NOT NULL CHECK (length(eid) BETWEEN 1 AND 64),
  name_ru text NOT NULL CHECK (length(name_ru) BETWEEN 1 AND 80),
  known_ru text NOT NULL CHECK (length(known_ru) BETWEEN 1 AND 80),
  aliases_ru text[] NOT NULL DEFAULT '{}' CHECK (cardinality(aliases_ru) <= 24),
  qualifier_ru text CHECK (qualifier_ru IS NULL OR length(qualifier_ru) BETWEEN 1 AND 60),
  PRIMARY KEY (version, kind, eid)
);

-- The Russian names an entity release is judged with, written once and never changed: a Cyrillic answer then means the
-- same entity for as long as the release is played. Written only when every entity of the release has a Russian name
-- (a partial set would make "this Cyrillic name is known" depend on the list).
CREATE TABLE IF NOT EXISTS public.tenable_ru_releases (
  kind text NOT NULL CHECK (kind IN ('player', 'manager', 'club', 'nation')),
  release_id text NOT NULL CHECK (length(release_id) BETWEEN 1 AND 64),
  players_version text REFERENCES public.wordgame_ru_versions(version) ON DELETE RESTRICT,
  names_version text REFERENCES public.tenable_ru_name_sets(version) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, release_id),
  CONSTRAINT chk_tenable_ru_releases_source CHECK (
    CASE WHEN kind = 'player' THEN players_version IS NOT NULL AND names_version IS NULL
         ELSE names_version IS NOT NULL AND players_version IS NULL END)
);

CREATE OR REPLACE FUNCTION public.tenable_ru_releases_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'tenable_ru_releases rows are written once (a release keeps its Russian names)';
END $$;
DROP TRIGGER IF EXISTS tenable_ru_releases_immutable ON public.tenable_ru_releases;
CREATE TRIGGER tenable_ru_releases_immutable BEFORE UPDATE OR DELETE ON public.tenable_ru_releases
  FOR EACH ROW EXECUTE FUNCTION public.tenable_ru_releases_immutable();

-- A set of names is written once, with its set row, and never changed: a pinned release or a frozen run keeps exactly
-- the names it was checked with.
CREATE OR REPLACE FUNCTION public.tenable_ru_names_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- now() is the transaction's start: only the transaction that created the set may add to it.
    IF (SELECT created_at FROM public.tenable_ru_name_sets WHERE version = NEW.version) = now() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Tenable Russian names are written only with their set';
  END IF;
  RAISE EXCEPTION 'Tenable Russian names never change';
END $$;
DROP TRIGGER IF EXISTS tenable_ru_names_immutable ON public.tenable_ru_names;
CREATE TRIGGER tenable_ru_names_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.tenable_ru_names
  FOR EACH ROW EXECUTE FUNCTION public.tenable_ru_names_immutable();
REVOKE ALL ON FUNCTION public.tenable_ru_names_immutable() FROM PUBLIC, anon, authenticated;

-- A set's row never changes: its creation time decides which transaction may add names to it.
CREATE OR REPLACE FUNCTION public.tenable_ru_name_sets_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Tenable Russian name sets never change';
END $$;
DROP TRIGGER IF EXISTS tenable_ru_name_sets_immutable ON public.tenable_ru_name_sets;
CREATE TRIGGER tenable_ru_name_sets_immutable BEFORE UPDATE ON public.tenable_ru_name_sets
  FOR EACH ROW EXECUTE FUNCTION public.tenable_ru_name_sets_immutable();
REVOKE ALL ON FUNCTION public.tenable_ru_name_sets_immutable() FROM PUBLIC, anon, authenticated;

-- Russian title and note of a list, display only, outside the list itself (a stored list's hash is its content
-- version: rewriting it would be a correction). `src` is a hash of the English title and note it was translated from:
-- a list corrected in English shows English until it is translated again.
CREATE TABLE IF NOT EXISTS public.tenable_list_ru (
  list_id text NOT NULL CHECK (length(list_id) BETWEEN 1 AND 80),
  src text NOT NULL CHECK (length(src) BETWEEN 8 AND 64),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 90),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, src)
);

-- Server-only like the lists: titles of future days and of private room lists must never be readable through the Data API.
ALTER TABLE public.tenable_ru_name_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenable_ru_names ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenable_ru_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenable_list_ru ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenable_ru_name_sets, public.tenable_ru_names, public.tenable_ru_releases, public.tenable_list_ru FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tenable_ru_name_sets, public.tenable_ru_names, public.tenable_ru_releases, public.tenable_list_ru TO service_role;
REVOKE ALL ON FUNCTION public.tenable_ru_releases_immutable() FROM PUBLIC, anon, authenticated;
