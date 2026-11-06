-- Georgian and Turkish campaign quiz pages mirror the Spanish, Russian, Portuguese and German editions: nullable
-- per-language copies of the page fields, with English as the fallback. Georgian already has ka_h1, ka_lede,
-- ka_seo_title and ka_meta_description. Nullable columns without a default are a catalog-only change; fail fast
-- instead of queueing behind traffic.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.campaign_quizzes
  ADD COLUMN IF NOT EXISTS ka_title TEXT,
  ADD COLUMN IF NOT EXISTS ka_breadcrumb_label TEXT,
  ADD COLUMN IF NOT EXISTS ka_about_heading TEXT,
  ADD COLUMN IF NOT EXISTS ka_about_blocks JSONB,
  ADD COLUMN IF NOT EXISTS ka_hero_image_alt TEXT,
  ADD COLUMN IF NOT EXISTS ka_og_image_alt TEXT,
  ADD COLUMN IF NOT EXISTS ka_score_cta TEXT,
  ADD COLUMN IF NOT EXISTS ka_footer_banner_text TEXT,
  ADD COLUMN IF NOT EXISTS ka_footer_button_label TEXT,
  ADD COLUMN IF NOT EXISTS tr_title TEXT,
  ADD COLUMN IF NOT EXISTS tr_h1 TEXT,
  ADD COLUMN IF NOT EXISTS tr_seo_title TEXT,
  ADD COLUMN IF NOT EXISTS tr_meta_description TEXT,
  ADD COLUMN IF NOT EXISTS tr_breadcrumb_label TEXT,
  ADD COLUMN IF NOT EXISTS tr_lede TEXT,
  ADD COLUMN IF NOT EXISTS tr_about_heading TEXT,
  ADD COLUMN IF NOT EXISTS tr_about_blocks JSONB,
  ADD COLUMN IF NOT EXISTS tr_hero_image_alt TEXT,
  ADD COLUMN IF NOT EXISTS tr_og_image_alt TEXT,
  ADD COLUMN IF NOT EXISTS tr_score_cta TEXT,
  ADD COLUMN IF NOT EXISTS tr_footer_banner_text TEXT,
  ADD COLUMN IF NOT EXISTS tr_footer_button_label TEXT;

COMMENT ON COLUMN public.campaign_quizzes.ka_about_blocks IS
  'Georgian equivalent of about_blocks; source content remains unchanged.';
COMMENT ON COLUMN public.campaign_quizzes.tr_about_blocks IS
  'Turkish equivalent of about_blocks; source content remains unchanged.';
