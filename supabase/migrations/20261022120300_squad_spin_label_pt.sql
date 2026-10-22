-- Squad Spin criterion labels in Portuguese: nullable, read with an English fallback until backfilled.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.squad_spin_criteria
  ADD COLUMN IF NOT EXISTS label_pt text CHECK (label_pt IS NULL OR length(label_pt) BETWEEN 1 AND 160);
