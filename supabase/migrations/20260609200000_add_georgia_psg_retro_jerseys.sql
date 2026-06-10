-- Add Georgia Retro and PSG Retro jerseys to the avatar store. Prices are in in-game coins.

INSERT INTO public.store_products (slug, type, name, description, price_cents, currency, metadata, is_active, sort_order)
VALUES
  (
    'avatar_jersey_georgia_retro',
    'avatar',
    '{"en":"Georgia Jersey"}'::jsonb,
    '{"en":"Layered avatar jersey"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_georgia_retro","slot":"jersey","assetUrl":"/assets/store/jersey_georgia_retro.webp"}'::jsonb,
    true,
    390
  ),
  (
    'avatar_jersey_psg_retro',
    'avatar',
    '{"en":"PSG Jersey"}'::jsonb,
    '{"en":"Layered avatar jersey"}'::jsonb,
    50000,
    'coins',
    '{"avatarPartId":"jersey_psg_retro","slot":"jersey","assetUrl":"/assets/store/jersey_psg_retro.webp"}'::jsonb,
    true,
    391
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
