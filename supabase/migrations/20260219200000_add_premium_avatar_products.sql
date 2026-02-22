-- Add premium purchasable profile avatars (idempotent by slug)

INSERT INTO public.store_products (slug, type, name, description, price_cents, currency, metadata, is_active, sort_order)
VALUES
  (
    'avatar_ronaldo',
    'avatar',
    '{"en":"Ronaldo Avatar"}'::jsonb,
    '{"en":"Unlock Ronaldo profile avatar"}'::jsonb,
    299,
    'usd',
    '{"avatarKey":"ronaldo","assetUrl":"https://api.dicebear.com/7.x/big-smile/svg?seed=ronaldo&backgroundColor=b6e3f4%2Cc0aede%2Cd1d4f9&size=256"}'::jsonb,
    true,
    81
  ),
  (
    'avatar_messi',
    'avatar',
    '{"en":"Messi Avatar"}'::jsonb,
    '{"en":"Unlock Messi profile avatar"}'::jsonb,
    299,
    'usd',
    '{"avatarKey":"messi","assetUrl":"https://api.dicebear.com/7.x/big-smile/svg?seed=messi&backgroundColor=b6e3f4%2Cc0aede%2Cd1d4f9&size=256"}'::jsonb,
    true,
    82
  ),
  (
    'avatar_neymar',
    'avatar',
    '{"en":"Neymar Avatar"}'::jsonb,
    '{"en":"Unlock Neymar profile avatar"}'::jsonb,
    299,
    'usd',
    '{"avatarKey":"neymar","assetUrl":"https://api.dicebear.com/7.x/big-smile/svg?seed=neymar&backgroundColor=b6e3f4%2Cc0aede%2Cd1d4f9&size=256"}'::jsonb,
    true,
    83
  ),
  (
    'avatar_mbappe',
    'avatar',
    '{"en":"Mbappe Avatar"}'::jsonb,
    '{"en":"Unlock Mbappe profile avatar"}'::jsonb,
    299,
    'usd',
    '{"avatarKey":"mbappe","assetUrl":"https://api.dicebear.com/7.x/big-smile/svg?seed=mbappe&backgroundColor=b6e3f4%2Cc0aede%2Cd1d4f9&size=256"}'::jsonb,
    true,
    84
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
