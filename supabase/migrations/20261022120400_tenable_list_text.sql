-- Translated title and note of a Tenable list for languages after Russian (pt first), display only, outside the list
-- itself (a stored list's hash is its content version: rewriting it would be a correction). `src` is a hash of the
-- English title and note it was translated from: a list corrected in English shows English until translated again.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

CREATE TABLE IF NOT EXISTS public.tenable_list_text (
  locale text NOT NULL CHECK (locale IN ('pt')),
  list_id text NOT NULL CHECK (length(list_id) BETWEEN 1 AND 80),
  src text NOT NULL CHECK (length(src) BETWEEN 8 AND 64),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 90),
  note text CHECK (note IS NULL OR length(note) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (locale, list_id, src)
);

-- Server-only like the lists: titles of future days and of private room lists must never be readable through the Data API.
ALTER TABLE public.tenable_list_text ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenable_list_text FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tenable_list_text TO service_role;
