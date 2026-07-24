-- Public SEO quiz campaigns.
--
-- Campaign questions stay in the central question bank so the CMS,
-- translations, audit history, and payload validation remain the single
-- source of truth. Once reserved for a crawlable campaign page, a question is
-- explicitly excluded from normal and ranked gameplay.

ALTER TABLE public.questions
  ADD COLUMN IF NOT EXISTS ranked_eligible BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS public.campaign_quizzes (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_campaign_quizzes_slug
    CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT chk_campaign_quizzes_status
    CHECK (status IN ('draft', 'published', 'archived'))
);

DROP TRIGGER IF EXISTS trg_campaign_quizzes_set_updated_at ON public.campaign_quizzes;
CREATE TRIGGER trg_campaign_quizzes_set_updated_at
  BEFORE UPDATE ON public.campaign_quizzes
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE IF NOT EXISTS public.campaign_quiz_questions (
  quiz_slug TEXT NOT NULL
    REFERENCES public.campaign_quizzes(slug) ON DELETE CASCADE,
  question_id UUID NOT NULL
    REFERENCES public.questions(id) ON DELETE RESTRICT,
  difficulty TEXT NOT NULL,
  display_order SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (quiz_slug, question_id),
  CONSTRAINT uq_campaign_quiz_display_order
    UNIQUE (quiz_slug, display_order),
  CONSTRAINT uq_campaign_question_assignment
    UNIQUE (question_id),
  CONSTRAINT chk_campaign_quiz_difficulty
    CHECK (difficulty IN ('easy', 'medium', 'hard')),
  CONSTRAINT chk_campaign_quiz_display_order
    CHECK (display_order BETWEEN 1 AND 15)
);

CREATE OR REPLACE FUNCTION public.reserve_campaign_quiz_question()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.questions
  SET ranked_eligible = FALSE,
      updated_at = NOW()
  WHERE id = NEW.question_id;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_campaign_quiz_question()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_reserve_campaign_quiz_question
  ON public.campaign_quiz_questions;
CREATE TRIGGER trg_reserve_campaign_quiz_question
  AFTER INSERT OR UPDATE OF question_id
  ON public.campaign_quiz_questions
  FOR EACH ROW
  EXECUTE FUNCTION public.reserve_campaign_quiz_question();

ALTER TABLE public.campaign_quiz_questions
  ADD COLUMN IF NOT EXISTS difficulty TEXT;

UPDATE public.campaign_quiz_questions assignment
SET difficulty = question.difficulty
FROM public.questions question
WHERE question.id = assignment.question_id
  AND assignment.difficulty IS NULL;

ALTER TABLE public.campaign_quiz_questions
  ALTER COLUMN difficulty SET NOT NULL;

ALTER TABLE public.campaign_quiz_questions
  DROP CONSTRAINT IF EXISTS chk_campaign_quiz_difficulty;
ALTER TABLE public.campaign_quiz_questions
  ADD CONSTRAINT chk_campaign_quiz_difficulty
  CHECK (difficulty IN ('easy', 'medium', 'hard'));

ALTER TABLE public.campaign_quiz_questions
  DROP CONSTRAINT IF EXISTS chk_campaign_quiz_display_order;
ALTER TABLE public.campaign_quiz_questions
  ADD CONSTRAINT chk_campaign_quiz_display_order
  CHECK (display_order BETWEEN 1 AND 15);

CREATE INDEX IF NOT EXISTS idx_campaign_quiz_questions_order
  ON public.campaign_quiz_questions (quiz_slug, difficulty, display_order);

CREATE TABLE IF NOT EXISTS public.campaign_quiz_ratings (
  quiz_slug TEXT NOT NULL
    REFERENCES public.campaign_quizzes(slug) ON DELETE CASCADE,
  user_id UUID NOT NULL
    REFERENCES public.users(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (quiz_slug, user_id),
  CONSTRAINT chk_campaign_quiz_rating
    CHECK (rating BETWEEN 1 AND 5)
);

CREATE INDEX IF NOT EXISTS idx_campaign_quiz_ratings_slug
  ON public.campaign_quiz_ratings (quiz_slug);

DROP TRIGGER IF EXISTS trg_campaign_quiz_ratings_set_updated_at ON public.campaign_quiz_ratings;
CREATE TRIGGER trg_campaign_quiz_ratings_set_updated_at
  BEFORE UPDATE ON public.campaign_quiz_ratings
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- The API server reads these tables through its private Postgres connection.
-- Keep them unavailable through the public Supabase Data API.
ALTER TABLE public.campaign_quizzes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_quiz_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_quiz_ratings ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.campaign_quizzes
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.campaign_quiz_questions
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.campaign_quiz_ratings
  FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN public.questions.ranked_eligible IS
  'False for publicly exposed campaign questions that must not enter normal or ranked match question selection.';

COMMENT ON COLUMN public.campaign_quiz_questions.difficulty IS
  'Campaign-specific difficulty bucket. Every published campaign contains five easy, five medium, and five hard questions.';
