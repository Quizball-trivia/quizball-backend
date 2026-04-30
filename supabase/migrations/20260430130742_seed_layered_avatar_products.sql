-- Seed products for layered avatar equipment. Non-coin-pack prices are in in-game coins.

INSERT INTO public.store_products (slug, type, name, description, price_cents, currency, metadata, is_active, sort_order)
VALUES
  (
    'avatar_skin_white_alt',
    'avatar',
    '{"en":"Tan Skin"}'::jsonb,
    '{"en":"Layered avatar skin tone"}'::jsonb,
    500,
    'coins',
    '{"avatarPartId":"skin_male_white_alt","slot":"skin","assetUrl":"/assets/store/avatars/avatar_male_white_alt.webp"}'::jsonb,
    true,
    300
  ),
  (
    'avatar_skin_dark',
    'avatar',
    '{"en":"Brown Skin"}'::jsonb,
    '{"en":"Layered avatar skin tone"}'::jsonb,
    500,
    'coins',
    '{"avatarPartId":"skin_male_dark","slot":"skin","assetUrl":"/assets/store/avatars/avatar_male_dark.webp"}'::jsonb,
    true,
    301
  ),
  (
    'avatar_skin_dark_alt',
    'avatar',
    '{"en":"Dark Skin"}'::jsonb,
    '{"en":"Layered avatar skin tone"}'::jsonb,
    500,
    'coins',
    '{"avatarPartId":"skin_male_dark_alt","slot":"skin","assetUrl":"/assets/store/avatars/avatar_male_dark_alt.webp"}'::jsonb,
    true,
    302
  ),
  (
    'avatar_hair_girl_basic',
    'avatar',
    '{"en":"Girl Basic Hair"}'::jsonb,
    '{"en":"Layered avatar hair"}'::jsonb,
    500,
    'coins',
    '{"avatarPartId":"hair_girl_basic","slot":"hair","assetUrl":"/assets/store/hair_girl_basic.webp"}'::jsonb,
    true,
    320
  ),
  (
    'avatar_hair_hamsik',
    'avatar',
    '{"en":"Hamsik Hair"}'::jsonb,
    '{"en":"Layered avatar hair"}'::jsonb,
    500,
    'coins',
    '{"avatarPartId":"hair_hamsik","slot":"hair","assetUrl":"/assets/store/hair_hamsik.webp"}'::jsonb,
    true,
    321
  ),
  (
    'avatar_hair_ramos',
    'avatar',
    '{"en":"Ramos Hair"}'::jsonb,
    '{"en":"Layered avatar hair"}'::jsonb,
    700,
    'coins',
    '{"avatarPartId":"hair_ramos","slot":"hair","assetUrl":"/assets/store/hair_ramos.webp"}'::jsonb,
    true,
    322
  ),
  (
    'avatar_hair_ronaldo_brazil',
    'avatar',
    '{"en":"Ronaldo Brazil Hair"}'::jsonb,
    '{"en":"Layered avatar hair"}'::jsonb,
    1000,
    'coins',
    '{"avatarPartId":"hair_ronaldo_brazil","slot":"hair","assetUrl":"/assets/store/hair_ronaldo_brazil.webp"}'::jsonb,
    true,
    323
  ),
  (
    'avatar_hair_ronaldo_goat',
    'avatar',
    '{"en":"Ronaldo GOAT Hair"}'::jsonb,
    '{"en":"Layered avatar hair"}'::jsonb,
    700,
    'coins',
    '{"avatarPartId":"hair_ronaldo_goat","slot":"hair","assetUrl":"/assets/store/hair_ronaldo_goat.webp"}'::jsonb,
    true,
    324
  ),
  (
    'avatar_glasses_wayfarer',
    'avatar',
    '{"en":"Wayfarer Glasses"}'::jsonb,
    '{"en":"Layered avatar glasses"}'::jsonb,
    300,
    'coins',
    '{"avatarPartId":"glasses_wayfarer","slot":"glasses","assetUrl":"/assets/store/accessory_glasses_wayfarer.webp"}'::jsonb,
    true,
    340
  ),
  (
    'avatar_glasses_round',
    'avatar',
    '{"en":"Round Shades"}'::jsonb,
    '{"en":"Layered avatar glasses"}'::jsonb,
    400,
    'coins',
    '{"avatarPartId":"glasses_round","slot":"glasses","assetUrl":"/assets/store/accessory_glasses_round.webp"}'::jsonb,
    true,
    341
  ),
  (
    'avatar_glasses_aviator',
    'avatar',
    '{"en":"Aviator Glasses"}'::jsonb,
    '{"en":"Layered avatar glasses"}'::jsonb,
    400,
    'coins',
    '{"avatarPartId":"glasses_aviator","slot":"glasses","assetUrl":"/assets/store/accessory_glasses_aviator.webp"}'::jsonb,
    true,
    342
  ),
  (
    'avatar_facial_stache',
    'avatar',
    '{"en":"Mustache"}'::jsonb,
    '{"en":"Layered avatar facial hair"}'::jsonb,
    200,
    'coins',
    '{"avatarPartId":"stache","slot":"facialHair","assetUrl":"/assets/store/accessory_stache.webp"}'::jsonb,
    true,
    360
  ),
  (
    'avatar_facial_beard',
    'avatar',
    '{"en":"Beard"}'::jsonb,
    '{"en":"Layered avatar facial hair"}'::jsonb,
    350,
    'coins',
    '{"avatarPartId":"beard","slot":"facialHair","assetUrl":"/assets/store/accessory_beard.webp"}'::jsonb,
    true,
    361
  ),
  (
    'avatar_jersey_real',
    'avatar',
    '{"en":"Real Madrid Jersey"}'::jsonb,
    '{"en":"Layered avatar jersey"}'::jsonb,
    800,
    'coins',
    '{"avatarPartId":"jersey_real","slot":"jersey","assetUrl":"/assets/store/jersey_real.webp"}'::jsonb,
    true,
    380
  ),
  (
    'avatar_jersey_barcelona',
    'avatar',
    '{"en":"Barcelona Jersey"}'::jsonb,
    '{"en":"Layered avatar jersey"}'::jsonb,
    800,
    'coins',
    '{"avatarPartId":"jersey_barcelona","slot":"jersey","assetUrl":"/assets/store/jersey_barcelona.webp"}'::jsonb,
    true,
    381
  ),
  (
    'avatar_jersey_milan',
    'avatar',
    '{"en":"Milan Jersey"}'::jsonb,
    '{"en":"Layered avatar jersey"}'::jsonb,
    1500,
    'coins',
    '{"avatarPartId":"jersey_milan","slot":"jersey","assetUrl":"/assets/store/jersey_milan.webp"}'::jsonb,
    true,
    382
  ),
  (
    'avatar_jersey_liverpool',
    'avatar',
    '{"en":"Liverpool Jersey"}'::jsonb,
    '{"en":"Layered avatar jersey"}'::jsonb,
    1000,
    'coins',
    '{"avatarPartId":"jersey_liverpool","slot":"jersey","assetUrl":"/assets/store/jersey_liverpool.webp"}'::jsonb,
    true,
    383
  ),
  (
    'avatar_jersey_bayern',
    'avatar',
    '{"en":"Bayern Jersey"}'::jsonb,
    '{"en":"Layered avatar jersey"}'::jsonb,
    1200,
    'coins',
    '{"avatarPartId":"jersey_bayern","slot":"jersey","assetUrl":"/assets/store/jersey_bayern.webp"}'::jsonb,
    true,
    384
  ),
  (
    'avatar_jersey_argentina_retro',
    'avatar',
    '{"en":"Argentina Retro Jersey"}'::jsonb,
    '{"en":"Layered avatar jersey"}'::jsonb,
    500,
    'coins',
    '{"avatarPartId":"jersey_argentina_retro","slot":"jersey","assetUrl":"/assets/store/jersey_argentina_retro.webp"}'::jsonb,
    true,
    385
  ),
  (
    'avatar_jersey_brazil_retro',
    'avatar',
    '{"en":"Brazil Retro Jersey"}'::jsonb,
    '{"en":"Layered avatar jersey"}'::jsonb,
    500,
    'coins',
    '{"avatarPartId":"jersey_brazil_retro","slot":"jersey","assetUrl":"/assets/store/jersey_brazil_retro.webp"}'::jsonb,
    true,
    386
  ),
  (
    'avatar_jersey_france_retro',
    'avatar',
    '{"en":"France Retro Jersey"}'::jsonb,
    '{"en":"Layered avatar jersey"}'::jsonb,
    800,
    'coins',
    '{"avatarPartId":"jersey_france_retro","slot":"jersey","assetUrl":"/assets/store/jersey_france_retro.webp"}'::jsonb,
    true,
    387
  ),
  (
    'avatar_jersey_germany_retro',
    'avatar',
    '{"en":"Germany Retro Jersey"}'::jsonb,
    '{"en":"Layered avatar jersey"}'::jsonb,
    800,
    'coins',
    '{"avatarPartId":"jersey_germany_retro","slot":"jersey","assetUrl":"/assets/store/jersey_germany_retro.webp"}'::jsonb,
    true,
    388
  ),
  (
    'avatar_jersey_netherlands_retro',
    'avatar',
    '{"en":"Netherlands Retro Jersey"}'::jsonb,
    '{"en":"Layered avatar jersey"}'::jsonb,
    800,
    'coins',
    '{"avatarPartId":"jersey_netherlands_retro","slot":"jersey","assetUrl":"/assets/store/jersey_netherlands_retro.webp"}'::jsonb,
    true,
    389
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
