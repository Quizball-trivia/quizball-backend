-- Football Grid criterion labels in Spanish and Turkish. Nullable: the client
-- falls back to label_en until the backfill script has run.

ALTER TABLE public.football_grid_criteria
  ADD COLUMN IF NOT EXISTS label_es text CHECK (label_es IS NULL OR length(label_es) BETWEEN 1 AND 160),
  ADD COLUMN IF NOT EXISTS label_tr text CHECK (label_tr IS NULL OR length(label_tr) BETWEEN 1 AND 160);

-- Published grid content stays append-only, except that the two locale label
-- columns may be backfilled: an UPDATE that changes nothing else passes.
CREATE OR REPLACE FUNCTION public.football_grid_reject_mutation_except_locale_labels()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'label_es' - 'label_tr') = (to_jsonb(OLD) - 'label_es' - 'label_tr') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'published football grid content is append-only';
END;
$$;

DROP TRIGGER IF EXISTS football_grid_criteria_immutable ON public.football_grid_criteria;
CREATE TRIGGER football_grid_criteria_immutable
  BEFORE UPDATE OR DELETE ON public.football_grid_criteria
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_reject_mutation_except_locale_labels();
