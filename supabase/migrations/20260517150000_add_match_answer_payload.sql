ALTER TABLE public.match_answers
  ADD COLUMN IF NOT EXISTS answer_payload jsonb NOT NULL DEFAULT '{}'::jsonb;
