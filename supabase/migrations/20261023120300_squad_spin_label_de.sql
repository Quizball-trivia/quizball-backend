-- Squad Spin criterion labels in German: nullable, read with an English fallback until backfilled.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.squad_spin_criteria
  ADD COLUMN IF NOT EXISTS label_de text CHECK (label_de IS NULL OR length(label_de) BETWEEN 1 AND 160);
