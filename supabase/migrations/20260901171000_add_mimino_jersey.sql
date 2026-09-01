INSERT INTO public.store_products (slug, type, name, description, price_cents, currency, metadata, is_active, sort_order)
VALUES (
  'avatar_jersey_mimino',
  'avatar',
  '{"en":"Mimino Jersey","ka":"მიმინოს მაისური","es":"Camiseta de Mimino"}'::jsonb,
  '{"en":"Layered avatar jersey","ka":"ავატარის მაისური","es":"Camiseta de avatar en capas"}'::jsonb,
  5000,
  'coins',
  '{"avatarPartId":"jersey_mimino","slot":"jersey","assetUrl":"/assets/store/jersey_mimino.webp"}'::jsonb,
  true,
  417
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
