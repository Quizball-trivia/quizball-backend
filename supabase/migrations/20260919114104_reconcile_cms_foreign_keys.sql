-- Preserve slug-update cascading and prevent deletion of referenced pages.
-- Already-recorded CMS files do not rerun when their old bodies change.
ALTER TABLE public.campaign_quizzes DROP CONSTRAINT fk_campaign_quizzes_question_set;
ALTER TABLE public.campaign_quizzes ADD CONSTRAINT fk_campaign_quizzes_question_set
  FOREIGN KEY (question_set_slug) REFERENCES public.campaign_quizzes(slug)
  ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.campaign_quiz_routes DROP CONSTRAINT campaign_quiz_routes_target_slug_fkey;
ALTER TABLE public.campaign_quiz_routes ADD CONSTRAINT campaign_quiz_routes_target_slug_fkey
  FOREIGN KEY (target_slug) REFERENCES public.campaign_quizzes(slug)
  ON UPDATE CASCADE ON DELETE RESTRICT NOT VALID;
