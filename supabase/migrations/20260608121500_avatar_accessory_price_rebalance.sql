-- Add 200 coins to non-jersey avatar equipment prices.
--
-- Non-coin-pack store products use price_cents as the in-game coin cost.

UPDATE public.store_products
SET price_cents = CASE slug
  WHEN 'avatar_hair_girl_basic' THEN 700
  WHEN 'avatar_hair_hamsik' THEN 700
  WHEN 'avatar_hair_ramos' THEN 900
  WHEN 'avatar_hair_ronaldo_brazil' THEN 1200
  WHEN 'avatar_hair_ronaldo_goat' THEN 900
  WHEN 'avatar_glasses_wayfarer' THEN 500
  WHEN 'avatar_glasses_round' THEN 600
  WHEN 'avatar_glasses_aviator' THEN 600
  WHEN 'avatar_facial_stache' THEN 400
  WHEN 'avatar_facial_beard' THEN 550
  ELSE price_cents
END,
currency = 'coins'
WHERE slug IN (
  'avatar_hair_girl_basic',
  'avatar_hair_hamsik',
  'avatar_hair_ramos',
  'avatar_hair_ronaldo_brazil',
  'avatar_hair_ronaldo_goat',
  'avatar_glasses_wayfarer',
  'avatar_glasses_round',
  'avatar_glasses_aviator',
  'avatar_facial_stache',
  'avatar_facial_beard'
);
