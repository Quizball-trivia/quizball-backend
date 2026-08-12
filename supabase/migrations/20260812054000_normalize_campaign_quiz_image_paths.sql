-- Store environment-neutral object paths. Each deployment resolves these
-- paths through its own SUPABASE_URL, so a staging row cannot remain pinned to
-- the production Storage/CDN origin (and vice versa).
UPDATE public.campaign_quizzes
SET hero_image_url = regexp_replace(
  hero_image_url,
  '^https?://[^/]+/storage/v1/object/public/imgs/',
  ''
)
WHERE hero_image_url ~ '^https?://[^/]+/storage/v1/object/public/imgs/';

UPDATE public.campaign_quizzes
SET og_image_url = regexp_replace(
  og_image_url,
  '^https?://[^/]+/storage/v1/object/public/imgs/',
  ''
)
WHERE og_image_url ~ '^https?://[^/]+/storage/v1/object/public/imgs/';
