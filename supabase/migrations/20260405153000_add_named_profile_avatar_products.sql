-- Add local profile avatar assets and make them purchasable in the store.

UPDATE public.store_products
SET metadata = jsonb_build_object(
  'avatarKey', 'ronaldo',
  'assetUrl', '/assets/store/avatars/ronaldo.png'
)
WHERE slug = 'avatar_ronaldo'
  AND type = 'avatar';

UPDATE public.store_products
SET metadata = jsonb_build_object(
  'avatarKey', 'messi',
  'assetUrl', '/assets/store/avatars/messi.png'
)
WHERE slug = 'avatar_messi'
  AND type = 'avatar';

INSERT INTO public.store_products (slug, type, name, description, price_cents, currency, metadata, is_active, sort_order)
VALUES
  (
    'avatar_ronaldinho',
    'avatar',
    '{"en":"Ronaldinho Avatar"}'::jsonb,
    '{"en":"Unlock Ronaldinho profile avatar"}'::jsonb,
    299,
    'usd',
    '{"avatarKey":"ronaldinho","assetUrl":"/assets/store/avatars/ronaldinho.png"}'::jsonb,
    true,
    85
  )
ON CONFLICT (slug) DO UPDATE SET
  type = EXCLUDED.type,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_cents = EXCLUDED.price_cents,
  currency = EXCLUDED.currency,
  metadata = EXCLUDED.metadata,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order;
