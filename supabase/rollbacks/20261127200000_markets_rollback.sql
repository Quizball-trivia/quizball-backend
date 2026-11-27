-- Rollback for 20261127200000_markets.sql. Home markets and market-only flags
-- set on categories are lost; HQ's own labels (harness.category_markets) are untouched.
ALTER TABLE public.categories
  DROP CONSTRAINT IF EXISTS categories_market_only_needs_market,
  DROP COLUMN IF EXISTS market_only,
  DROP COLUMN IF EXISTS market;
DROP TABLE IF EXISTS public.markets;
DROP FUNCTION IF EXISTS public.markets_check_countries();
