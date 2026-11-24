-- Greek names for the word games: an immutable, versioned overlay keyed by the durable footballer id, shared by every
-- release, exactly like the Russian one (20261016130400_wordgame_ru_names.sql) plus up to four Greek alternative
-- spellings per footballer (typed forms, read as aliases). Runs and rooms freeze the version they started with; at
-- most one version is active for new ones. The names themselves are loaded per environment, never by a migration.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE IF NOT EXISTS public.wordgame_el_versions (
  version text PRIMARY KEY CHECK (version ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  fingerprint text NOT NULL,
  players integer NOT NULL CHECK (players > 0),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wordgame_el_versions_one_active ON public.wordgame_el_versions (active) WHERE active;

CREATE TABLE IF NOT EXISTS public.wordgame_el_names (
  version text NOT NULL REFERENCES public.wordgame_el_versions(version) ON DELETE RESTRICT,
  pid text NOT NULL CHECK (length(pid) BETWEEN 1 AND 64),
  name_el text NOT NULL CHECK (length(name_el) BETWEEN 1 AND 80),
  game_name_el text NOT NULL CHECK (length(game_name_el) BETWEEN 1 AND 80),
  aliases_el text[] NOT NULL DEFAULT '{}' CHECK (cardinality(aliases_el) <= 4 AND array_position(aliases_el, NULL) IS NULL),
  fame integer NOT NULL CHECK (fame BETWEEN 0 AND 100),
  PRIMARY KEY (version, pid)
);

-- A set of names is written once, with its set row, and never changed: a frozen run or room keeps exactly the names it
-- was checked with.
CREATE OR REPLACE FUNCTION public.wordgame_el_names_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- now() is the transaction's start: only the transaction that created the set may add to it.
    IF (SELECT created_at FROM public.wordgame_el_versions WHERE version = NEW.version) = now() THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Word game Greek names are written only with their set';
  END IF;
  RAISE EXCEPTION 'Word game Greek names never change';
END $$;
DROP TRIGGER IF EXISTS wordgame_el_names_immutable ON public.wordgame_el_names;
CREATE TRIGGER wordgame_el_names_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.wordgame_el_names
  FOR EACH ROW EXECUTE FUNCTION public.wordgame_el_names_immutable();
REVOKE ALL ON FUNCTION public.wordgame_el_names_immutable() FROM PUBLIC, anon, authenticated;

-- A set's row never changes but for `active`: its creation time decides which transaction may add names to it.
CREATE OR REPLACE FUNCTION public.wordgame_el_versions_fixed() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.version, NEW.fingerprint, NEW.players, NEW.created_at) IS DISTINCT FROM (OLD.version, OLD.fingerprint, OLD.players, OLD.created_at) THEN
    RAISE EXCEPTION 'Word game Greek name versions never change (only active does)';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wordgame_el_versions_fixed ON public.wordgame_el_versions;
CREATE TRIGGER wordgame_el_versions_fixed BEFORE UPDATE ON public.wordgame_el_versions
  FOR EACH ROW EXECUTE FUNCTION public.wordgame_el_versions_fixed();
REVOKE ALL ON FUNCTION public.wordgame_el_versions_fixed() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.wordgame_el_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wordgame_el_names ENABLE ROW LEVEL SECURITY;
