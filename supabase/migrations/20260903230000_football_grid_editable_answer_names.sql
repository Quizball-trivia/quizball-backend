-- Published grid content stays append-only, with one exception: the two
-- display-name columns on board answers may be corrected in place (owner
-- decision 2026-09-03) so a bad translation no longer needs a republish.
-- Every other column, and deletes, are still rejected.
CREATE OR REPLACE FUNCTION public.football_grid_reject_mutation_except_names()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'published football grid content is append-only';
  END IF;
  IF (to_jsonb(NEW) - 'player_name_en' - 'player_name_ka')
     IS DISTINCT FROM (to_jsonb(OLD) - 'player_name_en' - 'player_name_ka') THEN
    RAISE EXCEPTION 'published football grid content is append-only (only player display names may change)';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS football_grid_answers_immutable ON public.football_grid_board_answers;
CREATE TRIGGER football_grid_answers_immutable
  BEFORE UPDATE OR DELETE ON public.football_grid_board_answers
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_reject_mutation_except_names();

CREATE TABLE IF NOT EXISTS public.football_grid_player_name_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  football_player_id uuid NOT NULL REFERENCES public.football_players(id),
  previous_name_en text,
  previous_name_ka text,
  name_en text,
  name_ka text,
  rows_updated integer NOT NULL,
  aliases_added integer NOT NULL DEFAULT 0,
  reason text NOT NULL,
  actor text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS football_grid_player_name_edits_player_idx
  ON public.football_grid_player_name_edits (football_player_id, created_at DESC);
ALTER TABLE public.football_grid_player_name_edits ENABLE ROW LEVEL SECURITY;
