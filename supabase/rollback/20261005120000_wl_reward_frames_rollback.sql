-- Roll back the Weekend League podium frames. Deploy code without frames in
-- WL_PACK_ITEM_SLUGS first. A product is only removed while nothing references it: no
-- inventory row AND no reward receipt (a frozen but not yet granted v2 receipt
-- would otherwise fail its grant forever, coins and jersey included).
DELETE FROM public.store_products p
WHERE p.slug IN ('avatar_frame_wl_champion', 'avatar_frame_wl_runnerup', 'avatar_frame_wl_podium')
  AND NOT EXISTS (SELECT 1 FROM public.user_inventory ui WHERE ui.product_id = p.id)
  AND NOT EXISTS (
    SELECT 1 FROM public.wl_reward_receipts r
    WHERE r.items @> jsonb_build_array(jsonb_build_object('slug', p.slug))
  );
