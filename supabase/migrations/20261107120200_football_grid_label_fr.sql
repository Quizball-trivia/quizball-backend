-- Football Grid criterion labels in French. Nullable: the client falls back to
-- label_en until they are backfilled. The check is validated in the next migration, under a weaker lock.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.football_grid_criteria
  ADD COLUMN IF NOT EXISTS label_fr text,
  DROP CONSTRAINT IF EXISTS football_grid_criteria_label_fr_check,
  ADD CONSTRAINT football_grid_criteria_label_fr_check
    CHECK (label_fr IS NULL OR length(label_fr) BETWEEN 1 AND 160) NOT VALID;

-- Published grid content stays append-only, except that the locale label
-- columns may be backfilled: an UPDATE that changes nothing else passes.
CREATE OR REPLACE FUNCTION public.football_grid_reject_mutation_except_locale_labels()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - 'label_es' - 'label_tr' - 'label_ru' - 'label_pt' - 'label_de' - 'label_fr') = (to_jsonb(OLD) - 'label_es' - 'label_tr' - 'label_ru' - 'label_pt' - 'label_de' - 'label_fr') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'published football grid content is append-only';
END;
$$;
