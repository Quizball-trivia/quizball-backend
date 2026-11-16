-- Squad Spin in Greek: nullable criterion labels and player names (Greek letters, as Greek media write them), read
-- with an English fallback until backfilled. The checks are validated in the next migration, under a weaker lock.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.squad_spin_criteria
  ADD COLUMN IF NOT EXISTS label_el text,
  DROP CONSTRAINT IF EXISTS squad_spin_criteria_label_el_check,
  ADD CONSTRAINT squad_spin_criteria_label_el_check
    CHECK (label_el IS NULL OR length(label_el) BETWEEN 1 AND 160) NOT VALID;

ALTER TABLE public.squad_spin_players
  ADD COLUMN IF NOT EXISTS name_el text,
  DROP CONSTRAINT IF EXISTS squad_spin_players_name_el_check,
  ADD CONSTRAINT squad_spin_players_name_el_check
    CHECK (name_el IS NULL OR length(name_el) BETWEEN 1 AND 160) NOT VALID;
