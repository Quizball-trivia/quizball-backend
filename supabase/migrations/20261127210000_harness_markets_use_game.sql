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

-- The HQ still running during this deploy writes this table on every market
-- change. Make such a write wait, so none lands between the copy and the drop
-- and is lost silently; once the table is gone the waiting write fails instead.
LOCK TABLE harness.category_markets IN SHARE ROW EXCLUSIVE MODE;

UPDATE public.categories c
SET market = cm.market
FROM harness.category_markets cm
WHERE cm.category_id = c.id
  AND c.market_only = false
  AND c.market IS DISTINCT FROM cm.market
  AND EXISTS (SELECT 1 FROM public.markets m WHERE m.code = cm.market);

-- A home market with no HQ label is taken to be a label removed in HQ since the
-- copy: HQ is the only screen that sets markets so far (the categories API can,
-- but nothing calls it with one). Checked on production before this ran: no
-- category had a market without an HQ label.
UPDATE public.categories c
SET market = NULL
WHERE c.market IS NOT NULL
  AND c.market_only = false
  AND NOT EXISTS (SELECT 1 FROM harness.category_markets cm WHERE cm.category_id = c.id);

DROP TABLE harness.category_markets;
