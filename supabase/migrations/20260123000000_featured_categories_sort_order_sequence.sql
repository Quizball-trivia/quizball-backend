-- =============================================================================
-- Migration: Add sequence-backed sort_order for featured_categories
-- Description: Uses a sequence to safely allocate sort_order for inserts.
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'S'
      AND c.relname = 'featured_categories_sort_order_seq'
      AND n.nspname = 'public'
  ) THEN
    CREATE SEQUENCE public.featured_categories_sort_order_seq;
  END IF;
END $$;

ALTER SEQUENCE public.featured_categories_sort_order_seq
  OWNED BY public.featured_categories.sort_order;

ALTER TABLE public.featured_categories
  ALTER COLUMN sort_order SET DEFAULT nextval('public.featured_categories_sort_order_seq');

SELECT setval(
  'public.featured_categories_sort_order_seq',
  GREATEST(COALESCE((SELECT MAX(sort_order) FROM public.featured_categories), 0), 1),
  true
);
