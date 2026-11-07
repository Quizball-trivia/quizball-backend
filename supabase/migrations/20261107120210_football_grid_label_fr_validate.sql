-- Separate transaction from the column: validation allows reads and writes.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.football_grid_criteria VALIDATE CONSTRAINT football_grid_criteria_label_fr_check;
