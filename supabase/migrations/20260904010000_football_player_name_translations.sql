-- Georgian (and future locale) display names for players that have no
-- translated quiz answer yet. The grid content generator reads these as a
-- second name source so the player pool is no longer capped by the question
-- bank. Rows are reviewable: source records who produced the name.
CREATE TABLE IF NOT EXISTS public.football_player_name_translations (
  football_player_id uuid NOT NULL REFERENCES public.football_players(id) ON DELETE CASCADE,
  locale text NOT NULL CHECK (locale IN ('ka')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  source text NOT NULL,
  model text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (football_player_id, locale)
);
CREATE INDEX IF NOT EXISTS football_player_name_translations_name_idx
  ON public.football_player_name_translations (locale, name);
ALTER TABLE public.football_player_name_translations ENABLE ROW LEVEL SECURITY;
