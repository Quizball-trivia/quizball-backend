-- The HQ task a build-list item was queued for: the task finishes when the page
-- publishes (hq.quiz_pages_enqueue / hq.quiz_pages_report, previous migration).
ALTER TABLE public.campaign_quiz_backlog
  ADD COLUMN hq_task_id uuid REFERENCES hq.tasks(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX campaign_quiz_backlog_hq_task ON public.campaign_quiz_backlog (hq_task_id) WHERE hq_task_id IS NOT NULL;

-- A quiz-page report is about one version of its page. When the page's content
-- moves on (the agent's next commit, or a save in the CMS), its unreviewed reports are
-- marked superseded, so the Director never judges a page that is no longer live
-- (the version check in hq.director_review_work then refuses the stale read).
-- Plain AFTER UPDATE: the version and content date are set by a BEFORE trigger, not by the SET list.
-- Same lock order as publishing: the page row first, then its reports.
CREATE FUNCTION public.campaign_quiz_supersede_hq_reports()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE hq.tasks t
     SET review_state = 'superseded', reviewed_at = now(), updated_at = now(),
         review_note = 'The page changed since this report (now version ' || NEW.version || ')'
    FROM hq.members m
   WHERE m.id = t.assignee_id AND m.runtime = 'quiz_pages'
     AND t.status = 'done' AND t.review_state IS NULL AND t.escalated_at IS NULL
     AND t.ref ->> 'quiz_page' = NEW.slug
     AND (t.ref ->> 'version')::integer < NEW.version;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_campaign_quiz_supersede_hq_reports
  AFTER UPDATE ON public.campaign_quizzes
  FOR EACH ROW
  -- Content or publication state changed: the version also moves on bookkeeping writes (review dates, hub order),
  -- which leave what the Director checked intact.
  WHEN (NEW.content_modified_at IS DISTINCT FROM OLD.content_modified_at OR NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION public.campaign_quiz_supersede_hq_reports();

REVOKE ALL ON FUNCTION public.campaign_quiz_supersede_hq_reports() FROM PUBLIC;
