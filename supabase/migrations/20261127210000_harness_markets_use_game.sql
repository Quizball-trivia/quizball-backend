-- HQ stops keeping its own market labels. The game now defines markets itself
-- (20261127200000_markets.sql: public.markets, categories.market and
-- categories.market_only), so HQ reads and writes those.
--
-- HQ's labels were copied to categories.market when the game's migration ran.
-- Labels changed in HQ since then are carried over here, once, and
-- harness.category_markets goes away. A category that is market-only keeps its
-- market: that flag did not exist in HQ, so HQ cannot have unset it.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'categories' AND column_name = 'market_only'
  ) THEN
    RAISE EXCEPTION 'apply 20261127200000_markets.sql (the game''s market definition) first';
  END IF;
END;
$$;

UPDATE public.categories c
SET market = cm.market
FROM harness.category_markets cm
WHERE cm.category_id = c.id
  AND c.market_only = false
  AND c.market IS DISTINCT FROM cm.market
  AND EXISTS (SELECT 1 FROM public.markets m WHERE m.code = cm.market);

UPDATE public.categories c
SET market = NULL
WHERE c.market IS NOT NULL
  AND c.market_only = false
  AND NOT EXISTS (SELECT 1 FROM harness.category_markets cm WHERE cm.category_id = c.id);

DROP TABLE harness.category_markets;
