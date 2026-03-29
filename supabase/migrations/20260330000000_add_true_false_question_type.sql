ALTER TABLE questions
  DROP CONSTRAINT IF EXISTS chk_questions_type;

ALTER TABLE questions
  ADD CONSTRAINT chk_questions_type
  CHECK (type IN ('mcq_single', 'true_false', 'input_text', 'countdown_list', 'clue_chain', 'put_in_order'));
