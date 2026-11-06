-- Squad Spin criterion labels in Spanish and Turkish: nullable, read with an English fallback until backfilled.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.squad_spin_criteria
  ADD COLUMN IF NOT EXISTS label_es text CHECK (label_es IS NULL OR length(label_es) BETWEEN 1 AND 160),
  ADD COLUMN IF NOT EXISTS label_tr text CHECK (label_tr IS NULL OR length(label_tr) BETWEEN 1 AND 160);
