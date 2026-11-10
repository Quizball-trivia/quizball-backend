-- Page state for the quiz-page agent and for search engines.
--   version             bumps on every write; writers send the version they read (optimistic lock)
--   content_modified_at  last real change of what the page renders (copy in any language, images, questions);
--                        existing pages start from their last update
--   last_reviewed_at     last agent/owner review, with or without a change
--   next_refresh_at      when the refresh job takes the page again
--   agent_locked         the owner keeps the agent away from this page
--   managed_by           who created the page
ALTER TABLE public.campaign_quizzes
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN content_modified_at timestamptz,
  ADD COLUMN last_reviewed_at timestamptz,
  ADD COLUMN next_refresh_at timestamptz,
  ADD COLUMN agent_locked boolean NOT NULL DEFAULT false,
  ADD COLUMN managed_by text NOT NULL DEFAULT 'cms',
  ADD CONSTRAINT chk_campaign_quizzes_managed_by CHECK (managed_by IN ('cms', 'agent'));

-- Existing pages start from their last update without touching updated_at (the sitemap still reads it).
ALTER TABLE public.campaign_quizzes DISABLE TRIGGER trg_campaign_quizzes_set_updated_at;
UPDATE public.campaign_quizzes SET content_modified_at = updated_at;
ALTER TABLE public.campaign_quizzes ENABLE TRIGGER trg_campaign_quizzes_set_updated_at;

CREATE INDEX idx_campaign_quizzes_next_refresh
  ON public.campaign_quizzes (next_refresh_at)
  WHERE status = 'published' AND agent_locked = false;

CREATE OR REPLACE FUNCTION public.campaign_quiz_page_written()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  bookkeeping constant text[] := ARRAY[
    'version', 'updated_at', 'updated_by', 'created_at', 'created_by', 'content_modified_at', 'last_reviewed_at',
    'next_refresh_at', 'agent_locked', 'managed_by', 'hub_order', 'is_hub_pinned', 'preview_token', 'internal_name',
    'status', 'scheduled_publish_at', 'published_at', 'unpublished_at'
  ];
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1;
    NEW.content_modified_at := COALESCE(NEW.content_modified_at, now());
    RETURN NEW;
  END IF;
  NEW.version := OLD.version + 1;
  IF NEW.content_modified_at IS NOT DISTINCT FROM OLD.content_modified_at
    AND (to_jsonb(NEW) - bookkeeping) IS DISTINCT FROM (to_jsonb(OLD) - bookkeeping) THEN
    NEW.content_modified_at := now();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.campaign_quiz_page_written() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_campaign_quiz_page_written
  BEFORE INSERT OR UPDATE ON public.campaign_quizzes
  FOR EACH ROW
  EXECUTE FUNCTION public.campaign_quiz_page_written();
