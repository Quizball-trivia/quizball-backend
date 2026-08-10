-- Point each new club category at the artwork uploaded to the current
-- environment's own public storage bucket. Deriving the base from an existing
-- category keeps the migration portable between staging and production.
WITH category_storage AS (
  SELECT regexp_replace(image_url, '/[^/]+$', '') AS base_url
  FROM public.categories
  WHERE slug = 'arsenal'
    AND image_url IS NOT NULL
  LIMIT 1
)
UPDATE public.categories category
SET image_url = storage.base_url || '/' || category.slug || '-v2.webp',
    updated_at = NOW()
FROM category_storage storage
WHERE category.slug IN (
  'aston-villa',
  'bournemouth',
  'brentford',
  'brighton',
  'coventry-city',
  'crystal-palace',
  'fulham',
  'hull-city',
  'ipswich-town',
  'leeds-united',
  'newcastle-united',
  'nottingham-forest',
  'sunderland'
);
