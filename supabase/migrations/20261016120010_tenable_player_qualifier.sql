-- Tells namesakes apart in Tenable's suggestions ("ARG · 1987"): an overlay keyed by the footballer release and id,
-- so the word games' release table and its pipeline stay as they are. Written once per release by the Tenable entity
-- seed (immutable afterwards, like the release). New, empty table.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.tenable_player_meta (
  release_id text NOT NULL REFERENCES public.wordgame_releases(id) ON DELETE CASCADE,
  pid text NOT NULL,
  qualifier text NOT NULL,
  PRIMARY KEY (release_id, pid),
  CONSTRAINT chk_tenable_player_meta_qualifier CHECK (char_length(qualifier) BETWEEN 1 AND 40)
);
ALTER TABLE public.tenable_player_meta ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenable_player_meta FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tenable_player_meta TO service_role;
