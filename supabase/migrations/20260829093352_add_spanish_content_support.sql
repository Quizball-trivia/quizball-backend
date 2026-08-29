-- Spanish content is additive: English and Georgian values remain the source
-- fallback, while translated fields can be populated and rolled back without
-- rewriting their source content.

ALTER TABLE public.player_clue_cards
  DROP CONSTRAINT IF EXISTS player_clue_cards_locale_check;

ALTER TABLE public.player_clue_cards
  ADD CONSTRAINT player_clue_cards_locale_check
  CHECK (locale IN ('en', 'ka', 'es'));

ALTER TABLE public.campaign_quizzes
  ADD COLUMN IF NOT EXISTS es_title TEXT,
  ADD COLUMN IF NOT EXISTS es_h1 TEXT,
  ADD COLUMN IF NOT EXISTS es_seo_title TEXT,
  ADD COLUMN IF NOT EXISTS es_meta_description TEXT,
  ADD COLUMN IF NOT EXISTS es_breadcrumb_label TEXT,
  ADD COLUMN IF NOT EXISTS es_lede TEXT,
  ADD COLUMN IF NOT EXISTS es_about_heading TEXT,
  ADD COLUMN IF NOT EXISTS es_about_blocks JSONB,
  ADD COLUMN IF NOT EXISTS es_hero_image_alt TEXT,
  ADD COLUMN IF NOT EXISTS es_score_cta TEXT,
  ADD COLUMN IF NOT EXISTS es_footer_banner_text TEXT,
  ADD COLUMN IF NOT EXISTS es_footer_button_label TEXT;

-- Goal celebrations are not installed in every environment yet. Keep the
-- Spanish campaign migration deployable where that optional feature is absent.
DO $$
BEGIN
  IF to_regclass('public.goal_choreographies') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.goal_choreographies ADD COLUMN IF NOT EXISTS match_label_es TEXT';
  END IF;
END
$$;

COMMENT ON COLUMN public.campaign_quizzes.es_about_blocks IS
  'Spanish equivalent of about_blocks; source content remains unchanged.';
