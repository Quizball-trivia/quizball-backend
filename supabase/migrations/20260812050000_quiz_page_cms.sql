-- CMS-managed SEO quiz landing pages.
--
-- Existing campaign_quizzes rows remain the source of their reserved question
-- sets. New pages may attach one of those sets through question_set_slug. The
-- API is the only reader/writer: public Supabase roles retain no table access.

ALTER TABLE public.campaign_quizzes
  ADD COLUMN IF NOT EXISTS internal_name TEXT,
  ADD COLUMN IF NOT EXISTS page_category TEXT NOT NULL DEFAULT 'team',
  ADD COLUMN IF NOT EXISTS question_set_slug TEXT,
  ADD COLUMN IF NOT EXISTS h1 TEXT,
  ADD COLUMN IF NOT EXISTS lede TEXT,
  ADD COLUMN IF NOT EXISTS about_heading TEXT,
  ADD COLUMN IF NOT EXISTS about_blocks JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS score_cta TEXT,
  ADD COLUMN IF NOT EXISTS footer_banner_text TEXT,
  ADD COLUMN IF NOT EXISTS footer_button_label TEXT NOT NULL DEFAULT 'Play Ranked',
  ADD COLUMN IF NOT EXISTS hero_image_url TEXT,
  ADD COLUMN IF NOT EXISTS hero_image_alt TEXT,
  ADD COLUMN IF NOT EXISTS seo_title TEXT,
  ADD COLUMN IF NOT EXISTS meta_description TEXT,
  ADD COLUMN IF NOT EXISTS og_image_url TEXT,
  ADD COLUMN IF NOT EXISTS og_image_alt TEXT,
  ADD COLUMN IF NOT EXISTS breadcrumb_label TEXT,
  ADD COLUMN IF NOT EXISTS locale_mode TEXT NOT NULL DEFAULT 'en_only',
  ADD COLUMN IF NOT EXISTS ka_seo_title TEXT,
  ADD COLUMN IF NOT EXISTS ka_meta_description TEXT,
  ADD COLUMN IF NOT EXISTS ka_h1 TEXT,
  ADD COLUMN IF NOT EXISTS ka_lede TEXT,
  ADD COLUMN IF NOT EXISTS scheduled_publish_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS unpublished_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS preview_token UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS hub_order INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

WITH ordered_quizzes AS (
  SELECT slug, ROW_NUMBER() OVER (ORDER BY created_at, slug)::int AS position
  FROM public.campaign_quizzes
)
UPDATE public.campaign_quizzes quiz
SET internal_name = COALESCE(NULLIF(quiz.internal_name, ''), quiz.title),
    h1 = COALESCE(NULLIF(quiz.h1, ''), quiz.title),
    seo_title = COALESCE(NULLIF(quiz.seo_title, ''), quiz.title || ' | QuizBall'),
    breadcrumb_label = COALESCE(NULLIF(quiz.breadcrumb_label, ''), quiz.title),
    question_set_slug = COALESCE(quiz.question_set_slug, quiz.slug),
    published_at = CASE
      WHEN quiz.status = 'published' THEN COALESCE(quiz.published_at, quiz.updated_at, NOW())
      ELSE quiz.published_at
    END,
    hub_order = CASE
      WHEN quiz.hub_order = 0 THEN ordered.position
      ELSE quiz.hub_order
    END
FROM ordered_quizzes ordered
WHERE ordered.slug = quiz.slug;

ALTER TABLE public.campaign_quizzes
  ALTER COLUMN internal_name SET NOT NULL,
  ALTER COLUMN h1 SET NOT NULL,
  ALTER COLUMN seo_title SET NOT NULL,
  ALTER COLUMN breadcrumb_label SET NOT NULL,
  ALTER COLUMN question_set_slug SET NOT NULL;

ALTER TABLE public.campaign_quizzes
  DROP CONSTRAINT IF EXISTS chk_campaign_quizzes_status;
ALTER TABLE public.campaign_quizzes
  ADD CONSTRAINT chk_campaign_quizzes_status
    CHECK (status IN ('draft', 'preview', 'published', 'archived')),
  ADD CONSTRAINT chk_campaign_quizzes_page_category
    CHECK (page_category IN ('team', 'league', 'quiz_type', 'article')),
  ADD CONSTRAINT chk_campaign_quizzes_locale_mode
    CHECK (locale_mode IN ('en_only', 'en_ka')),
  ADD CONSTRAINT chk_campaign_quizzes_about_blocks
    CHECK (jsonb_typeof(about_blocks) = 'array'),
  ADD CONSTRAINT fk_campaign_quizzes_question_set
    FOREIGN KEY (question_set_slug)
    REFERENCES public.campaign_quizzes(slug)
    ON UPDATE CASCADE
    ON DELETE RESTRICT;

-- Slugs are editable in the CMS. Cascading the natural-key change keeps its
-- reserved set and ratings attached while the route table preserves the old URL.
ALTER TABLE public.campaign_quiz_questions
  DROP CONSTRAINT IF EXISTS campaign_quiz_questions_quiz_slug_fkey;
ALTER TABLE public.campaign_quiz_questions
  ADD CONSTRAINT campaign_quiz_questions_quiz_slug_fkey
    FOREIGN KEY (quiz_slug)
    REFERENCES public.campaign_quizzes(slug)
    ON UPDATE CASCADE
    ON DELETE CASCADE;

ALTER TABLE public.campaign_quiz_ratings
  DROP CONSTRAINT IF EXISTS campaign_quiz_ratings_quiz_slug_fkey;
ALTER TABLE public.campaign_quiz_ratings
  ADD CONSTRAINT campaign_quiz_ratings_quiz_slug_fkey
    FOREIGN KEY (quiz_slug)
    REFERENCES public.campaign_quizzes(slug)
    ON UPDATE CASCADE
    ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS public.campaign_quiz_related_pages (
  quiz_slug TEXT NOT NULL
    REFERENCES public.campaign_quizzes(slug) ON UPDATE CASCADE ON DELETE CASCADE,
  related_slug TEXT NOT NULL
    REFERENCES public.campaign_quizzes(slug) ON UPDATE CASCADE ON DELETE CASCADE,
  display_order SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (quiz_slug, related_slug),
  CONSTRAINT uq_campaign_quiz_related_order UNIQUE (quiz_slug, display_order),
  CONSTRAINT chk_campaign_quiz_related_order CHECK (display_order BETWEEN 1 AND 6),
  CONSTRAINT chk_campaign_quiz_related_not_self CHECK (quiz_slug <> related_slug)
);

CREATE INDEX IF NOT EXISTS idx_campaign_quiz_related_pages_related
  ON public.campaign_quiz_related_pages (related_slug);

CREATE TABLE IF NOT EXISTS public.campaign_quiz_routes (
  old_slug TEXT PRIMARY KEY,
  status_code SMALLINT NOT NULL,
  target_slug TEXT
    REFERENCES public.campaign_quizzes(slug) ON UPDATE CASCADE ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  CONSTRAINT chk_campaign_quiz_route_slug
    CHECK (old_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT chk_campaign_quiz_route_status
    CHECK (status_code IN (301, 410)),
  CONSTRAINT chk_campaign_quiz_route_target
    CHECK (
      (status_code = 301 AND target_slug IS NOT NULL AND old_slug <> target_slug)
      OR (status_code = 410 AND target_slug IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_campaign_quizzes_public_hub
  ON public.campaign_quizzes (page_category, hub_order, published_at)
  WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_campaign_quizzes_question_set
  ON public.campaign_quizzes (question_set_slug);

ALTER TABLE public.campaign_quiz_related_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_quiz_routes ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.campaign_quiz_related_pages
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.campaign_quiz_routes
  FROM PUBLIC, anon, authenticated;

COMMENT ON COLUMN public.campaign_quizzes.question_set_slug IS
  'Slug whose campaign_quiz_questions rows supply this page. Only public, ranked-ineligible sets may be published.';
COMMENT ON COLUMN public.campaign_quizzes.lede IS
  'English lede template. {count} is replaced with the attached set size at render time.';
COMMENT ON COLUMN public.campaign_quizzes.score_cta IS
  'Score-screen template. Supports {score}, {total}, and {count} variables.';
COMMENT ON TABLE public.campaign_quiz_routes IS
  'Permanent redirect and gone records for changed, unpublished, or deleted quiz-page slugs.';
