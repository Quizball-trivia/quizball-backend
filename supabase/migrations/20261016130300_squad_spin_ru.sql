-- Squad Spin in Russian: nullable label/name columns, read with an English fallback until
-- scripts/squad-spin-ru.ts has backfilled them.
ALTER TABLE public.squad_spin_criteria
  ADD COLUMN IF NOT EXISTS label_ru text CHECK (label_ru IS NULL OR length(label_ru) BETWEEN 1 AND 160);
ALTER TABLE public.squad_spin_players
  ADD COLUMN IF NOT EXISTS name_ru text CHECK (name_ru IS NULL OR length(name_ru) BETWEEN 1 AND 160);
