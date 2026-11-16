-- Greek campaign quiz pages mirror the other editions: nullable el_* copies of the page fields, with English as
-- the fallback. Nullable columns without a default are a catalog-only change; fail fast instead of queueing behind
-- traffic.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.campaign_quizzes
  ADD COLUMN IF NOT EXISTS el_title TEXT,
  ADD COLUMN IF NOT EXISTS el_h1 TEXT,
  ADD COLUMN IF NOT EXISTS el_seo_title TEXT,
  ADD COLUMN IF NOT EXISTS el_meta_description TEXT,
  ADD COLUMN IF NOT EXISTS el_breadcrumb_label TEXT,
  ADD COLUMN IF NOT EXISTS el_lede TEXT,
  ADD COLUMN IF NOT EXISTS el_about_heading TEXT,
  ADD COLUMN IF NOT EXISTS el_about_blocks JSONB,
  ADD COLUMN IF NOT EXISTS el_hero_image_alt TEXT,
  ADD COLUMN IF NOT EXISTS el_og_image_alt TEXT,
  ADD COLUMN IF NOT EXISTS el_score_cta TEXT,
  ADD COLUMN IF NOT EXISTS el_footer_banner_text TEXT,
  ADD COLUMN IF NOT EXISTS el_footer_button_label TEXT;

COMMENT ON COLUMN public.campaign_quizzes.el_about_blocks IS
  'Greek equivalent of about_blocks; source content remains unchanged.';
