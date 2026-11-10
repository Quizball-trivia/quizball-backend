-- Every change to a campaign question set is kept as an immutable version, so a round that started on one set can
-- still be answered (with the same generated options) after the set was rotated, and a restore brings back the exact
-- questions. One version per transaction per set, whoever writes the set (CMS, agent, tools): the trigger is deferred
-- to commit, so it sees the final set and a rewrite that ends where it started records nothing.
CREATE TABLE public.campaign_quiz_set_versions (
  set_slug text NOT NULL REFERENCES public.campaign_quizzes(slug) ON DELETE CASCADE ON UPDATE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  questions jsonb NOT NULL CHECK (jsonb_typeof(questions) = 'array'),
  txid bigint NOT NULL DEFAULT txid_current(),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (set_slug, version)
);

ALTER TABLE public.campaign_quiz_set_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.campaign_quiz_set_versions FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION public.record_campaign_quiz_set_version(target_slug text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  current_questions jsonb;
  latest record;
BEGIN
  -- A set whose page is being deleted cascades its rows away; there is nothing left to version.
  IF NOT EXISTS (SELECT 1 FROM public.campaign_quizzes WHERE slug = target_slug) THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('campaign_quiz_set:' || target_slug));
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'question_id', assignment.question_id,
    'difficulty', assignment.difficulty,
    'display_order', assignment.display_order
  ) ORDER BY assignment.display_order), '[]'::jsonb)
  INTO current_questions
  FROM public.campaign_quiz_questions assignment
  WHERE assignment.quiz_slug = target_slug;

  SELECT version, questions, txid INTO latest
  FROM public.campaign_quiz_set_versions
  WHERE set_slug = target_slug
  ORDER BY version DESC
  LIMIT 1;

  IF latest.version IS NOT NULL AND latest.txid = txid_current() THEN
    IF latest.questions IS NOT DISTINCT FROM current_questions THEN
      RETURN;
    END IF;
    UPDATE public.campaign_quiz_set_versions
    SET questions = current_questions
    WHERE set_slug = target_slug AND version = latest.version;
  ELSIF latest.version IS NULL OR latest.questions IS DISTINCT FROM current_questions THEN
    INSERT INTO public.campaign_quiz_set_versions (set_slug, version, questions)
    VALUES (target_slug, COALESCE(latest.version, 0) + 1, current_questions);
  ELSE
    RETURN;
  END IF;

  -- Rotated questions are a real content change for every page that serves the set.
  UPDATE public.campaign_quizzes
  SET content_modified_at = now()
  WHERE question_set_slug = target_slug;
END;
$$;
REVOKE ALL ON FUNCTION public.record_campaign_quiz_set_version(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.campaign_quiz_set_changed()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM public.record_campaign_quiz_set_version(OLD.quiz_slug);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND (TG_OP = 'INSERT' OR NEW.quiz_slug IS DISTINCT FROM OLD.quiz_slug) THEN
    PERFORM public.record_campaign_quiz_set_version(NEW.quiz_slug);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.campaign_quiz_set_changed() FROM PUBLIC, anon, authenticated;

-- Trigger and baseline in one transaction: no assignment change can fall between them.
CREATE CONSTRAINT TRIGGER trg_campaign_quiz_set_changed
  AFTER INSERT OR UPDATE OR DELETE ON public.campaign_quiz_questions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.campaign_quiz_set_changed();

INSERT INTO public.campaign_quiz_set_versions (set_slug, version, questions, txid)
SELECT assignment.quiz_slug, 1,
  jsonb_agg(jsonb_build_object(
    'question_id', assignment.question_id,
    'difficulty', assignment.difficulty,
    'display_order', assignment.display_order
  ) ORDER BY assignment.display_order),
  0
FROM public.campaign_quiz_questions assignment
GROUP BY assignment.quiz_slug;
