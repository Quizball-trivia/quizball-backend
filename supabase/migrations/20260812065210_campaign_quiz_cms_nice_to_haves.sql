-- Optional editorial safeguards and hub merchandising controls for the quiz CMS.
-- Revisions are private API-owned records. They intentionally follow slug
-- renames, so the complete page history remains attached after a 301 is made.

ALTER TABLE public.campaign_quizzes
  ADD COLUMN IF NOT EXISTS is_hub_pinned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.campaign_quiz_revisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  quiz_slug TEXT NOT NULL
    REFERENCES public.campaign_quizzes(slug) ON UPDATE CASCADE ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  action TEXT NOT NULL,
  snapshot JSONB NOT NULL,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_campaign_quiz_revision_number UNIQUE (quiz_slug, revision_number),
  CONSTRAINT chk_campaign_quiz_revision_number CHECK (revision_number > 0),
  CONSTRAINT chk_campaign_quiz_revision_action CHECK (
    action IN ('created', 'saved', 'previewed', 'published', 'scheduled', 'unpublished', 'restored')
  ),
  CONSTRAINT chk_campaign_quiz_revision_snapshot CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_campaign_quiz_revisions_timeline
  ON public.campaign_quiz_revisions (quiz_slug, revision_number DESC);

DROP INDEX IF EXISTS public.idx_campaign_quizzes_public_hub;
CREATE INDEX IF NOT EXISTS idx_campaign_quizzes_public_hub
  ON public.campaign_quizzes (page_category, is_hub_pinned DESC, hub_order, published_at)
  WHERE status = 'published';

ALTER TABLE public.campaign_quiz_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.campaign_quiz_revisions
  FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON SEQUENCE public.campaign_quiz_revisions_id_seq
  FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.campaign_quiz_revisions IS
  'Private immutable CMS snapshots used for quiz-page history and rollback.';
COMMENT ON COLUMN public.campaign_quizzes.is_hub_pinned IS
  'Pinned pages sort ahead of unpinned pages within their hub category.';
