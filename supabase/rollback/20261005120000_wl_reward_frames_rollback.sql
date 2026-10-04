-- Roll back the Weekend League podium frames. Run ONLY before any frame has
-- been granted: inventory rows reference these products. Reward policy v2
-- code must be rolled back first, or a later freeze fails on missing products.
DELETE FROM public.store_products p
WHERE p.slug IN ('avatar_frame_wl_champion', 'avatar_frame_wl_runnerup', 'avatar_frame_wl_podium')
  AND NOT EXISTS (SELECT 1 FROM public.user_inventory ui WHERE ui.product_id = p.id);
