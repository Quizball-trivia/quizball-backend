-- Brazilian Portuguese campaign quiz pages mirror the Spanish and Russian editions: nullable pt_* copies of the
-- page fields, with English as the fallback. Nullable columns without a default are a catalog-only change; fail
-- fast instead of queueing behind traffic.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.campaign_quizzes
  ADD COLUMN IF NOT EXISTS pt_title TEXT,
  ADD COLUMN IF NOT EXISTS pt_h1 TEXT,
  ADD COLUMN IF NOT EXISTS pt_seo_title TEXT,
  ADD COLUMN IF NOT EXISTS pt_meta_description TEXT,
  ADD COLUMN IF NOT EXISTS pt_breadcrumb_label TEXT,
  ADD COLUMN IF NOT EXISTS pt_lede TEXT,
  ADD COLUMN IF NOT EXISTS pt_about_heading TEXT,
  ADD COLUMN IF NOT EXISTS pt_about_blocks JSONB,
  ADD COLUMN IF NOT EXISTS pt_hero_image_alt TEXT,
  ADD COLUMN IF NOT EXISTS pt_og_image_alt TEXT,
  ADD COLUMN IF NOT EXISTS pt_score_cta TEXT,
  ADD COLUMN IF NOT EXISTS pt_footer_banner_text TEXT,
  ADD COLUMN IF NOT EXISTS pt_footer_button_label TEXT;

COMMENT ON COLUMN public.campaign_quizzes.pt_about_blocks IS
  'Brazilian Portuguese equivalent of about_blocks; source content remains unchanged.';
