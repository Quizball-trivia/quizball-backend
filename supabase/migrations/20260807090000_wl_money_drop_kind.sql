-- Money Drop replaces Who-Am-I as the final WL round (5 mcq_single bet
-- questions, 300-point budget carried across the round). who_am_i stays in
-- the CHECK — historic tournaments hold rows of that kind.
ALTER TABLE public.wl_questions DROP CONSTRAINT IF EXISTS wl_questions_kind_check;
ALTER TABLE public.wl_questions ADD CONSTRAINT wl_questions_kind_check CHECK (kind IN (
  'true_false', 'higher_lower', 'mcq', 'career_path', 'who_am_i', 'money_drop'
));

-- The money-drop budget resolver reads the prior question's frozen run by
-- slot coordinates on every accept — give it an exact index.
CREATE INDEX IF NOT EXISTS idx_wl_question_runs_slot_status
  ON public.wl_question_runs (tournament_id, game_index, round_index, question_index)
  WHERE status IN ('frozen', 'revealed');
