-- Nullable, no-default expansion: older servers keep inserting/reading the
-- existing shape. Only the reviewed alignment operator fills old match rows.
ALTER TABLE public.match_questions ADD COLUMN content_snapshot jsonb;
COMMENT ON COLUMN public.match_questions.content_snapshot IS
  'Immutable prompt, difficulty, payload and category presentation captured by the release operator before catalogue alignment. Null retains legacy catalogue lookup.';

-- The existing operator journal stores full before/after question versions.
-- This private-table constraint does not change any gameplay content.
ALTER TABLE public.question_release_rows DROP CONSTRAINT question_release_rows_phase_check;
ALTER TABLE public.question_release_rows ADD CONSTRAINT question_release_rows_phase_check
  CHECK (phase IN ('import', 'publish', 'align', 'undo'));
