-- Point each new club category at the artwork uploaded to the current
-- environment's own public storage bucket. Deriving the base from an existing
-- category keeps the migration portable between staging and production.
DO $$
DECLARE
  category_storage_base TEXT;
  affected_rows INTEGER;
BEGIN
  SELECT regexp_replace(split_part(image_url, '?', 1), '/[^/]+$', '')
  INTO category_storage_base
  FROM public.categories
  WHERE slug = 'arsenal'
    AND split_part(image_url, '?', 1)
        LIKE '%/storage/v1/object/public/imgs/%'
  LIMIT 1;

  IF category_storage_base IS NULL OR category_storage_base = '' THEN
    RAISE EXCEPTION 'Cannot derive club artwork storage URL: Arsenal category image is missing or invalid';
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

  GET DIAGNOSTICS affected_rows = ROW_COUNT;
  IF affected_rows <> 13 THEN
    RAISE EXCEPTION 'Expected to update 13 club category images, updated %', affected_rows;
  END IF;
END $$;
