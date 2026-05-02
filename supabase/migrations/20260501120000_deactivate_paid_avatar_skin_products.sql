-- Skin tones are free avatar choices, not paid store products.
-- Keep historical rows/inventory safe by deactivating instead of deleting.

UPDATE public.store_products
SET is_active = false
WHERE slug IN (
  'avatar_skin_white_alt',
  'avatar_skin_dark',
  'avatar_skin_dark_alt'
);
