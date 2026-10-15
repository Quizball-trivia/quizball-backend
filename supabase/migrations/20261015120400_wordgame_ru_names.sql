-- Russian names for the word games: an immutable, versioned overlay keyed by the durable footballer id, shared by every
-- release. Runs and rooms freeze the version they started with; at most one version is active for new ones.
CREATE TABLE IF NOT EXISTS public.wordgame_ru_versions (
  version text PRIMARY KEY CHECK (version ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  fingerprint text NOT NULL,
  players integer NOT NULL CHECK (players > 0),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS wordgame_ru_versions_one_active ON public.wordgame_ru_versions (active) WHERE active;

CREATE TABLE IF NOT EXISTS public.wordgame_ru_names (
  version text NOT NULL REFERENCES public.wordgame_ru_versions(version) ON DELETE RESTRICT,
  pid text NOT NULL CHECK (length(pid) BETWEEN 1 AND 64),
  name_ru text NOT NULL CHECK (length(name_ru) BETWEEN 1 AND 80),
  game_name_ru text NOT NULL CHECK (length(game_name_ru) BETWEEN 1 AND 80),
  fame integer NOT NULL CHECK (fame BETWEEN 0 AND 100),
  PRIMARY KEY (version, pid)
);

ALTER TABLE public.wordgame_ru_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wordgame_ru_names ENABLE ROW LEVEL SECURITY;
