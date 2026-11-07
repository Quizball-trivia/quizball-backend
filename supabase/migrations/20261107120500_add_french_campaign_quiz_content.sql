-- French campaign quiz pages mirror the other editions: nullable fr_* copies of the page fields, with English as
-- the fallback. Nullable columns without a default are a catalog-only change; fail fast instead of queueing behind
-- traffic.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.campaign_quizzes
  ADD COLUMN IF NOT EXISTS fr_title TEXT,
  ADD COLUMN IF NOT EXISTS fr_h1 TEXT,
  ADD COLUMN IF NOT EXISTS fr_seo_title TEXT,
  ADD COLUMN IF NOT EXISTS fr_meta_description TEXT,
  ADD COLUMN IF NOT EXISTS fr_breadcrumb_label TEXT,
  ADD COLUMN IF NOT EXISTS fr_lede TEXT,
  ADD COLUMN IF NOT EXISTS fr_about_heading TEXT,
  ADD COLUMN IF NOT EXISTS fr_about_blocks JSONB,
  ADD COLUMN IF NOT EXISTS fr_hero_image_alt TEXT,
  ADD COLUMN IF NOT EXISTS fr_og_image_alt TEXT,
  ADD COLUMN IF NOT EXISTS fr_score_cta TEXT,
  ADD COLUMN IF NOT EXISTS fr_footer_banner_text TEXT,
  ADD COLUMN IF NOT EXISTS fr_footer_button_label TEXT;

COMMENT ON COLUMN public.campaign_quizzes.fr_about_blocks IS
  'French equivalent of about_blocks; source content remains unchanged.';
