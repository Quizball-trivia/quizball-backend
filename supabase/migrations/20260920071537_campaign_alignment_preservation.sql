-- Retain the complete original staging page/relation graph before canonical
-- alignment. Private operator journal; never exposed through the Data API.
CREATE TABLE public.campaign_alignment_batches (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  source_project text NOT NULL CHECK (source_project = 'lfbwhxvwubzeqkztghok'),
  target_project text NOT NULL CHECK (target_project = 'nsdfiprfmhdqhbfxfwpv'),
  plan_sha256 text NOT NULL CHECK (plan_sha256 = id),
  before_data jsonb NOT NULL,
  after_data jsonb,
  undo_data jsonb,
  verification jsonb NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz
);
ALTER TABLE public.campaign_alignment_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.campaign_alignment_batches FROM PUBLIC, anon, authenticated, service_role;

-- Replacing an assignment must not touch an already reserved question or
-- invalidate an earlier content-preservation receipt. New reservations retain
-- the existing behaviour and the CMS ownership guard remains enabled.
CREATE OR REPLACE FUNCTION public.reserve_campaign_quiz_question()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.questions
  SET ranked_eligible = FALSE,
      updated_at = NOW()
  WHERE id = NEW.question_id
    AND ranked_eligible IS DISTINCT FROM FALSE;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_campaign_quiz_question() FROM PUBLIC, anon, authenticated;
