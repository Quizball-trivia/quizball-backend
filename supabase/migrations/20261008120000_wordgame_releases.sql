-- Word games (name chain, played for both): the footballers a release knows. A release is written once, in one
-- transaction, and never changed: match packs and daily days name the release they were built for, so two replicas
-- always judge an answer against the same names. Private content: no client role can read it. New, empty tables.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.wordgame_releases (
  id text PRIMARY KEY,
  -- Hash of the release file: seeding the same id with different content is refused.
  fingerprint text NOT NULL,
  -- The matcher the release was built and checked with (src/modules/footballers MATCHER_VERSION).
  matcher_version integer NOT NULL,
  players integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_wordgame_releases_id CHECK (id ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  CONSTRAINT chk_wordgame_releases_fingerprint CHECK (char_length(fingerprint) BETWEEN 8 AND 64),
  CONSTRAINT chk_wordgame_releases_matcher CHECK (matcher_version > 0),
  CONSTRAINT chk_wordgame_releases_players CHECK (players > 0)
);

CREATE TABLE IF NOT EXISTS public.wordgame_players (
  release_id text NOT NULL REFERENCES public.wordgame_releases(id) ON DELETE CASCADE,
  -- Durable footballer id: the same person keeps it from one release to the next.
  pid text NOT NULL,
  name text NOT NULL,
  -- The name the footballer is known by: a chain's next letter is read from it.
  game_name text NOT NULL,
  fame integer NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (release_id, pid),
  CONSTRAINT chk_wordgame_players_pid CHECK (char_length(pid) BETWEEN 1 AND 64),
  CONSTRAINT chk_wordgame_players_name CHECK (char_length(name) BETWEEN 1 AND 80 AND char_length(game_name) BETWEEN 1 AND 80),
  CONSTRAINT chk_wordgame_players_fame CHECK (fame BETWEEN 0 AND 100),
  CONSTRAINT chk_wordgame_players_aliases CHECK (cardinality(aliases) <= 16)
);

ALTER TABLE public.wordgame_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wordgame_players ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wordgame_releases, public.wordgame_players FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wordgame_releases, public.wordgame_players TO service_role;
