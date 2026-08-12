-- Track whether a landing page uses an existing curated set or questions
-- entered directly in the Quiz Page CMS.
ALTER TABLE public.campaign_quizzes
  ADD COLUMN IF NOT EXISTS question_source TEXT NOT NULL DEFAULT 'existing';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'campaign_quizzes_question_source_check'
      AND conrelid = 'public.campaign_quizzes'::regclass
  ) THEN
    ALTER TABLE public.campaign_quizzes
      ADD CONSTRAINT campaign_quizzes_question_source_check
      CHECK (question_source IN ('existing', 'manual'));
  END IF;
END $$;

-- This ownership marker lets the CMS safely replace or delete only questions
-- that it created. Central-bank questions selected through the existing-set
-- picker are never modified by the quiz-page workflow.
CREATE TABLE IF NOT EXISTS public.campaign_quiz_manual_questions (
  question_id UUID PRIMARY KEY
    REFERENCES public.questions(id) ON DELETE CASCADE,
  quiz_slug TEXT NOT NULL
    REFERENCES public.campaign_quizzes(slug) ON UPDATE CASCADE ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaign_quiz_manual_questions_quiz_slug
  ON public.campaign_quiz_manual_questions (quiz_slug);

ALTER TABLE public.campaign_quiz_manual_questions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.campaign_quiz_manual_questions FROM anon, authenticated;

COMMENT ON COLUMN public.campaign_quizzes.question_source IS
  'existing selects a curated public-only campaign set; manual owns questions created in the Quiz Page CMS.';
COMMENT ON TABLE public.campaign_quiz_manual_questions IS
  'Private ownership marker for public-only, ranked-ineligible questions created by the Quiz Page CMS.';
