-- The name a club or national team is shown by in a language without its own directory (pt, de): "FC Bayern München",
-- "Alemanha". Display only, never judging: the server shows it only when the release reads it as that same entity, else
-- the English name. Keyed by entity id, so one row serves every release the entity is in.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE IF NOT EXISTS public.tenable_display_names (
  locale text NOT NULL CHECK (locale IN ('pt', 'de')),
  kind text NOT NULL CHECK (kind IN ('club', 'nation')),
  eid text NOT NULL CHECK (length(eid) BETWEEN 1 AND 64),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60 AND name = btrim(name)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (locale, kind, eid)
);

-- Server-only like the lists: which entities have names says nothing secret, but nothing reads it through the Data API.
ALTER TABLE public.tenable_display_names ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenable_display_names FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tenable_display_names TO service_role;
