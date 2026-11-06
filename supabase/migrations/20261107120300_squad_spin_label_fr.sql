-- Squad Spin criterion labels in French: nullable, read with an English fallback until backfilled. The check is validated
-- in the next migration, under a weaker lock.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.squad_spin_criteria
  ADD COLUMN IF NOT EXISTS label_fr text,
  DROP CONSTRAINT IF EXISTS squad_spin_criteria_label_fr_check,
  ADD CONSTRAINT squad_spin_criteria_label_fr_check
    CHECK (label_fr IS NULL OR length(label_fr) BETWEEN 1 AND 160) NOT VALID;
