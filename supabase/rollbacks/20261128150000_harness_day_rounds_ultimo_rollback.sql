DELETE FROM harness.jobs WHERE kind = 'round_plan' AND input->>'game' = 'ultimo';
DELETE FROM harness.day_rounds WHERE game = 'ultimo';
ALTER TABLE harness.day_rounds DROP CONSTRAINT IF EXISTS harness_day_rounds_game;
ALTER TABLE harness.day_rounds ADD CONSTRAINT harness_day_rounds_game CHECK (game IN ('pistas'));
DELETE FROM harness.policies WHERE key IN ('days.ultimo.ahead', 'days.ultimo.max_open_rounds', 'days.ultimo.store');

-- round_step_done keeps its newer body (the same steps, with finishing steps taken first): it is valid without Último.

NOTIFY pgrst, 'reload schema';
