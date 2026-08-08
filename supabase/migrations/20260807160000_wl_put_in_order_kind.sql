-- Aug-8 lineup: put_in_order replaces higher_lower as round 2 (who_am_i
-- returns as the finale). All kinds remain valid — rotation, not removal.
ALTER TABLE public.wl_questions DROP CONSTRAINT IF EXISTS wl_questions_kind_check;
ALTER TABLE public.wl_questions ADD CONSTRAINT wl_questions_kind_check CHECK (kind IN (
  'true_false', 'higher_lower', 'mcq', 'career_path', 'who_am_i', 'money_drop', 'put_in_order'
));
