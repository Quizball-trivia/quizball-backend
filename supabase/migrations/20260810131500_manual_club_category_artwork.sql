-- Point each new club category at the artwork uploaded to the current
-- environment's own public storage bucket. Deriving the base from an existing
-- category keeps the migration portable between staging and production.
DO $$
DECLARE
  category_storage_base TEXT;
BEGIN
  SELECT regexp_replace(split_part(image_url, '?', 1), '/[^/]+$', '')
  INTO category_storage_base
  FROM public.categories
  WHERE slug = 'arsenal'
    AND image_url IS NOT NULL
  LIMIT 1;

  IF category_storage_base IS NULL OR category_storage_base = '' THEN
    RAISE NOTICE 'Skipping club artwork URLs until the environment asset sync has run';
    RETURN;
  END IF;

  UPDATE public.categories category
  SET image_url = category_storage_base || '/' || category.slug || '-v2.webp',
      updated_at = NOW()
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
END $$;
