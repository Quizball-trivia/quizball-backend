CREATE TABLE IF NOT EXISTS public.season3_survey_state (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  snoozed_until timestamptz,
  last_prompt_at timestamptz,
  last_match_id uuid,
  assigned_kind text CHECK (assigned_kind IN ('vote','idea'))
);
CREATE TABLE IF NOT EXISTS public.season3_survey_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  match_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('vote','idea')),
  locale text NOT NULL CHECK (locale IN ('en','ka','es','tr')),
  remove_order boolean,
  remove_who boolean,
  idea text,
  created_at timestamptz NOT NULL DEFAULT now(),
  email_payload jsonb,
  email_status text NOT NULL CHECK (email_status IN ('not_required','suppressed','pending','sending','sent','review')),
  first_attempt_at timestamptz,
  attempted_at timestamptz,
  sent_at timestamptz,
  UNIQUE(user_id,kind),
  CHECK ((kind='vote' AND remove_order IS NOT NULL AND remove_who IS NOT NULL AND idea IS NULL)
      OR (kind='idea' AND remove_order IS NULL AND remove_who IS NULL AND length(trim(idea)) BETWEEN 1 AND 500))
);
CREATE INDEX IF NOT EXISTS season3_survey_email_pending ON public.season3_survey_responses(email_status,attempted_at)
  WHERE email_status IN ('pending','sending');
ALTER TABLE public.season3_survey_responses ADD COLUMN IF NOT EXISTS claim_token uuid;
ALTER TABLE public.season3_survey_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.season3_survey_responses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.season3_survey_state,public.season3_survey_responses FROM anon,authenticated;
-- Only the authenticated backend's DB role may access these tables. No Data API policies.
