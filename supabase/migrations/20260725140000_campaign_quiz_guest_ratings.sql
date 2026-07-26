-- Allow anonymous visitors to rate a public campaign quiz.
--
-- These pages are deliberately playable without an account, so requiring a
-- sign-up purely to leave a star rating suppressed almost all feedback and
-- left the AggregateRating schema empty. A guest rating is keyed by a hashed
-- IP so one visitor holds one updatable rating per quiz without us storing a
-- raw address.

-- The old composite primary key cannot express "either an account or a guest",
-- and it also pins user_id NOT NULL, so it has to go first.
ALTER TABLE public.campaign_quiz_ratings
  DROP CONSTRAINT IF EXISTS campaign_quiz_ratings_pkey;

ALTER TABLE public.campaign_quiz_ratings
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.campaign_quiz_ratings
  ADD COLUMN IF NOT EXISTS guest_key TEXT;

ALTER TABLE public.campaign_quiz_ratings
  ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();

ALTER TABLE public.campaign_quiz_ratings
  ADD CONSTRAINT campaign_quiz_ratings_pkey PRIMARY KEY (id);

-- Exactly one identity per row: an account rating or a guest rating.
ALTER TABLE public.campaign_quiz_ratings
  DROP CONSTRAINT IF EXISTS chk_campaign_quiz_rating_identity;
ALTER TABLE public.campaign_quiz_ratings
  ADD CONSTRAINT chk_campaign_quiz_rating_identity
  CHECK (num_nonnulls(user_id, guest_key) = 1);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_quiz_rating_user
  ON public.campaign_quiz_ratings (quiz_slug, user_id)
  WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_quiz_rating_guest
  ON public.campaign_quiz_ratings (quiz_slug, guest_key)
  WHERE guest_key IS NOT NULL;

COMMENT ON COLUMN public.campaign_quiz_ratings.guest_key IS
  'Salted hash of the rater IP for signed-out ratings. Never stores a raw address; null for account-bound ratings.';
