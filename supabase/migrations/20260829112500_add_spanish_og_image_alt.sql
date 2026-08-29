ALTER TABLE public.campaign_quizzes
  ADD COLUMN IF NOT EXISTS es_og_image_alt TEXT;
