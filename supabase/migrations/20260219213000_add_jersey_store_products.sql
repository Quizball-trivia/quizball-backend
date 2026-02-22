-- Add purchasable jersey avatars for store + fix legacy lion avatar asset URL.

UPDATE public.store_products
SET metadata = jsonb_build_object(
  'avatarKey', 'lion',
  'assetUrl', 'https://api.dicebear.com/7.x/big-smile/svg?seed=lion&backgroundColor=b6e3f4%2Cc0aede%2Cd1d4f9&size=256'
)
WHERE slug = 'avatar_lion'
  AND type = 'avatar';

INSERT INTO public.store_products (slug, type, name, description, price_cents, currency, metadata, is_active, sort_order)
VALUES
  (
    'avatar_jersey_home',
    'avatar',
    '{"en":"Home Jersey"}'::jsonb,
    '{"en":"Classic home kit profile avatar"}'::jsonb,
    399,
    'usd',
    '{"avatarKey":"jersey_home","assetUrl":"/assets/store/avatars/striker.svg"}'::jsonb,
    true,
    101
  ),
  (
    'avatar_jersey_away',
    'avatar',
    '{"en":"Away Jersey"}'::jsonb,
    '{"en":"Away kit profile avatar"}'::jsonb,
    499,
    'usd',
    '{"avatarKey":"jersey_away","assetUrl":"/assets/store/avatars/keeper.svg"}'::jsonb,
    true,
    102
  ),
  (
    'avatar_jersey_champions',
    'avatar',
    '{"en":"Champions Jersey"}'::jsonb,
    '{"en":"Elite kit profile avatar"}'::jsonb,
    699,
    'usd',
    '{"avatarKey":"jersey_champions","assetUrl":"/assets/store/avatars/legend.svg"}'::jsonb,
    true,
    103
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
