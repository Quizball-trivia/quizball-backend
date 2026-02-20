-- Restore friend UI avatar/jersey catalog as purchasable store products (idempotent by slug).
-- Non-coin-pack products are purchased with in-game coins, where price_cents acts as coin cost.

INSERT INTO public.store_products (slug, type, name, description, price_cents, currency, metadata, is_active, sort_order)
VALUES
  (
    'avatar_ronaldo',
    'avatar',
    '{"en":"Ronaldo"}'::jsonb,
    '{"en":"Premium profile avatar"}'::jsonb,
    299,
    'usd',
    '{"avatarKey":"ronaldo","assetUrl":"https://api.dicebear.com/7.x/big-smile/svg?seed=ronaldo&backgroundColor=b6e3f4%2Cc0aede%2Cd1d4f9&size=256"}'::jsonb,
    true,
    200
  ),
  (
    'avatar_messi',
    'avatar',
    '{"en":"Messi"}'::jsonb,
    '{"en":"Premium profile avatar"}'::jsonb,
    299,
    'usd',
    '{"avatarKey":"messi","assetUrl":"https://api.dicebear.com/7.x/big-smile/svg?seed=messi&backgroundColor=b6e3f4%2Cc0aede%2Cd1d4f9&size=256"}'::jsonb,
    true,
    201
  ),
  (
    'avatar_neymar',
    'avatar',
    '{"en":"Neymar"}'::jsonb,
    '{"en":"Premium profile avatar"}'::jsonb,
    299,
    'usd',
    '{"avatarKey":"neymar","assetUrl":"https://api.dicebear.com/7.x/big-smile/svg?seed=neymar&backgroundColor=b6e3f4%2Cc0aede%2Cd1d4f9&size=256"}'::jsonb,
    true,
    202
  ),
  (
    'avatar_mbappe',
    'avatar',
    '{"en":"Mbappe"}'::jsonb,
    '{"en":"Premium profile avatar"}'::jsonb,
    299,
    'usd',
    '{"avatarKey":"mbappe","assetUrl":"https://api.dicebear.com/7.x/big-smile/svg?seed=mbappe&backgroundColor=b6e3f4%2Cc0aede%2Cd1d4f9&size=256"}'::jsonb,
    true,
    203
  ),
  (
    'avatar_striker',
    'avatar',
    '{"en":"Striker"}'::jsonb,
    '{"en":"Store avatar"}'::jsonb,
    1000,
    'usd',
    '{"avatarKey":"striker","assetUrl":"/assets/store/avatars/striker.svg"}'::jsonb,
    true,
    210
  ),
  (
    'avatar_goalkeeper',
    'avatar',
    '{"en":"Goalkeeper"}'::jsonb,
    '{"en":"Store avatar"}'::jsonb,
    1200,
    'usd',
    '{"avatarKey":"goalkeeper","assetUrl":"/assets/store/avatars/keeper.svg"}'::jsonb,
    true,
    211
  ),
  (
    'avatar_captain',
    'avatar',
    '{"en":"Captain"}'::jsonb,
    '{"en":"Store avatar"}'::jsonb,
    1500,
    'usd',
    '{"avatarKey":"captain","assetUrl":"/assets/store/avatars/captain.svg"}'::jsonb,
    true,
    212
  ),
  (
    'avatar_legend',
    'avatar',
    '{"en":"Legend"}'::jsonb,
    '{"en":"Store avatar"}'::jsonb,
    2500,
    'usd',
    '{"avatarKey":"legend","assetUrl":"/assets/store/avatars/legend.svg"}'::jsonb,
    true,
    213
  ),
  (
    'avatar_jersey_home',
    'avatar',
    '{"en":"Home Jersey"}'::jsonb,
    '{"en":"Jersey cosmetic avatar"}'::jsonb,
    800,
    'usd',
    '{"avatarKey":"jersey_home","assetUrl":"/assets/store/jersey1.svg"}'::jsonb,
    true,
    220
  ),
  (
    'avatar_jersey_away',
    'avatar',
    '{"en":"Away Jersey"}'::jsonb,
    '{"en":"Jersey cosmetic avatar"}'::jsonb,
    800,
    'usd',
    '{"avatarKey":"jersey_away","assetUrl":"/assets/store/jersey2.svg"}'::jsonb,
    true,
    221
  ),
  (
    'avatar_jersey_third',
    'avatar',
    '{"en":"Third Kit"}'::jsonb,
    '{"en":"Jersey cosmetic avatar"}'::jsonb,
    1000,
    'usd',
    '{"avatarKey":"jersey_third","assetUrl":"/assets/store/jersey3.svg"}'::jsonb,
    true,
    222
  ),
  (
    'avatar_jersey_retro',
    'avatar',
    '{"en":"Retro Kit"}'::jsonb,
    '{"en":"Jersey cosmetic avatar"}'::jsonb,
    1200,
    'usd',
    '{"avatarKey":"jersey_retro","assetUrl":"/assets/store/jersey4.svg"}'::jsonb,
    true,
    223
  ),
  (
    'avatar_jersey_special',
    'avatar',
    '{"en":"Special Edition"}'::jsonb,
    '{"en":"Jersey cosmetic avatar"}'::jsonb,
    1500,
    'usd',
    '{"avatarKey":"jersey_special","assetUrl":"/assets/store/jesrsey5.svg"}'::jsonb,
    true,
    224
  ),
  (
    'avatar_jersey_gold',
    'avatar',
    '{"en":"Gold Kit"}'::jsonb,
    '{"en":"Jersey cosmetic avatar"}'::jsonb,
    2000,
    'usd',
    '{"avatarKey":"jersey_gold","assetUrl":"/assets/store/jersey6.svg"}'::jsonb,
    true,
    225
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
