-- Rollback for 20261127210000_harness_markets_use_game.sql: HQ keeps its own
-- labels again, rebuilt from the game's home markets. categories.market and
-- categories.market_only are left as they are.
CREATE TABLE harness.category_markets (
  category_id  uuid PRIMARY KEY REFERENCES public.categories(id) ON DELETE CASCADE,
  market       text NOT NULL CHECK (market IN ('ge', 'tr', 'ar', 'uk', 'es')),
  updated_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE harness.category_markets ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON harness.category_markets TO service_role';
  END IF;
END;
$$;
INSERT INTO harness.category_markets (category_id, market, updated_by)
SELECT id, market, 'rollback' FROM public.categories WHERE market IN ('ge', 'tr', 'ar', 'uk', 'es');
