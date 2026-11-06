-- Separate transaction from the column: validation allows reads and writes.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.squad_spin_criteria VALIDATE CONSTRAINT squad_spin_criteria_label_fr_check;
