-- PR1 possession engine refactor:
-- add last_attack phase kind while keeping shot for historical rows.

ALTER TABLE public.match_questions
  DROP CONSTRAINT IF EXISTS match_questions_phase_kind_check;

ALTER TABLE public.match_questions
  ADD CONSTRAINT match_questions_phase_kind_check
  CHECK (phase_kind IN ('normal', 'shot', 'penalty', 'last_attack'));

ALTER TABLE public.match_answers
  DROP CONSTRAINT IF EXISTS match_answers_phase_kind_check;

ALTER TABLE public.match_answers
  ADD CONSTRAINT match_answers_phase_kind_check
  CHECK (phase_kind IN ('normal', 'shot', 'penalty', 'last_attack'));
