-- CMS-created campaign questions are edited only through Quiz Pages. Keeping
-- this invariant in the database prevents the general Questions/Category tools
-- (or a future maintenance script) from bypassing publication validation and
-- revision history.
CREATE OR REPLACE FUNCTION public.protect_campaign_quiz_manual_question()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.campaign_quiz_manual_questions managed
    WHERE managed.question_id = OLD.id
  ) AND COALESCE(current_setting('quizball.campaign_quiz_write', TRUE), '') <> 'on' THEN
    RAISE EXCEPTION
      'Quiz Page questions must be changed through the Quiz Pages CMS'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_campaign_quiz_manual_question
  ON public.questions;
CREATE TRIGGER trg_protect_campaign_quiz_manual_question
  BEFORE UPDATE OR DELETE ON public.questions
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_campaign_quiz_manual_question();

REVOKE ALL ON FUNCTION public.protect_campaign_quiz_manual_question()
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.protect_campaign_quiz_manual_question() IS
  'Prevents non-Quiz-Pages workflows from mutating CMS-owned public-only questions.';
