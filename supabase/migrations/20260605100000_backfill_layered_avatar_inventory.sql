-- Backfill layered avatar inventory for users who already have paid parts equipped.
--
-- The layered avatar catalog was added after some users already had
-- avatar_customization values. Profile updates validate paid parts against
-- user_inventory, so the saved customization and inventory must agree.

WITH required_inventory AS (
  SELECT
    u.id AS user_id,
    sp.id AS product_id
  FROM public.users u
  CROSS JOIN LATERAL (
    VALUES
      (CASE u.avatar_customization->>'hair'
        WHEN 'hair_girl_basic' THEN 'avatar_hair_girl_basic'
        WHEN 'hair_hamsik' THEN 'avatar_hair_hamsik'
        WHEN 'hair_ramos' THEN 'avatar_hair_ramos'
        WHEN 'hair_ronaldo_brazil' THEN 'avatar_hair_ronaldo_brazil'
        WHEN 'hair_ronaldo_goat' THEN 'avatar_hair_ronaldo_goat'
      END),
      (CASE u.avatar_customization->>'jersey'
        WHEN 'jersey_real' THEN 'avatar_jersey_real'
        WHEN 'jersey_liverpool' THEN 'avatar_jersey_liverpool'
        WHEN 'jersey_barcelona' THEN 'avatar_jersey_barcelona'
        WHEN 'jersey_milan' THEN 'avatar_jersey_milan'
        WHEN 'jersey_bayern' THEN 'avatar_jersey_bayern'
        WHEN 'jersey_brazil_retro' THEN 'avatar_jersey_brazil_retro'
        WHEN 'jersey_argentina_retro' THEN 'avatar_jersey_argentina_retro'
        WHEN 'jersey_france_retro' THEN 'avatar_jersey_france_retro'
        WHEN 'jersey_germany_retro' THEN 'avatar_jersey_germany_retro'
        WHEN 'jersey_netherlands_retro' THEN 'avatar_jersey_netherlands_retro'
      END),
      (CASE u.avatar_customization->>'glasses'
        WHEN 'glasses_wayfarer' THEN 'avatar_glasses_wayfarer'
        WHEN 'glasses_round' THEN 'avatar_glasses_round'
        WHEN 'glasses_aviator' THEN 'avatar_glasses_aviator'
      END),
      (CASE u.avatar_customization->>'facialHair'
        WHEN 'stache' THEN 'avatar_facial_stache'
        WHEN 'beard' THEN 'avatar_facial_beard'
      END)
  ) AS required(slug)
  JOIN public.store_products sp
    ON sp.slug = required.slug
  WHERE jsonb_typeof(u.avatar_customization) = 'object'
    AND required.slug IS NOT NULL
)
INSERT INTO public.user_inventory (user_id, product_id, quantity)
SELECT DISTINCT
  user_id,
  product_id,
  1
FROM required_inventory
ON CONFLICT (user_id, product_id)
DO UPDATE SET
  quantity = GREATEST(public.user_inventory.quantity, EXCLUDED.quantity);
