-- "That was right" reports from the two word games: a text the game refused that the player says is a correct
-- footballer (a missing alias, a club spell the data lacks). Read privately once a week to improve the next footballer
-- release; never shown to players. New, empty table: the plain index builds block nothing.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.wordgame_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game text NOT NULL,
  source text NOT NULL,
  -- The daily run or the room match the text was refused in (the reporter played it).
  context_id uuid NOT NULL,
  -- The pair of the run / the round of the match; 0 where the game has no rounds of fixed content.
  round smallint NOT NULL DEFAULT 0,
  release_id text NOT NULL,
  -- Played for both: the two club keys ("a|b", sorted). Null for the name chain.
  subject text,
  typed text NOT NULL,
  -- The text folded the way the matcher reads it: one report per reporter, place and folded text.
  norm text NOT NULL,
  -- The footballer the text names in the release, when it names one (then the claim is about the clubs, not the name).
  resolved_pid text,
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  guest_id uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_wordgame_reports_game CHECK (game IN ('shared_player', 'name_chain')),
  CONSTRAINT chk_wordgame_reports_source CHECK (source IN ('daily', 'room')),
  CONSTRAINT chk_wordgame_reports_round CHECK (round >= 0 AND round < 64),
  CONSTRAINT chk_wordgame_reports_typed CHECK (char_length(typed) BETWEEN 1 AND 60 AND char_length(norm) BETWEEN 1 AND 60),
  CONSTRAINT chk_wordgame_reports_subject CHECK (subject IS NULL OR char_length(subject) <= 200),
  CONSTRAINT chk_wordgame_reports_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL))
);

-- One report per reporter, place and text; the same indexes count a reporter's reports of the last day.
CREATE UNIQUE INDEX IF NOT EXISTS uq_wordgame_reports_user ON public.wordgame_reports (user_id, context_id, round, norm) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wordgame_reports_guest ON public.wordgame_reports (guest_id, context_id, round, norm) WHERE guest_id IS NOT NULL;
-- The weekly read and the retention purge.
CREATE INDEX IF NOT EXISTS idx_wordgame_reports_created ON public.wordgame_reports (created_at);

ALTER TABLE public.wordgame_reports ENABLE ROW LEVEL SECURITY;
