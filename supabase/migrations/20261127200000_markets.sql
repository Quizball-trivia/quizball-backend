-- Markets: the game's own definition of "who is this for".
--
--   Everything is for all markets unless it says otherwise.
--   A category can name a home market (market = 'ge'): everyone can still play
--   it, and players in that market are offered it more often and see it first.
--   A category can also be only for its market (market_only = true): players
--   outside that market are never offered it.
--
-- A player's market comes from their country (profile country, else where they
-- are playing from). Countries that belong to no market have no market: those
-- players get everything that is not market-only.

CREATE TABLE public.markets (
  code       text PRIMARY KEY CHECK (code ~ '^[a-z]{2,8}$'),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  -- ISO 3166-1 alpha-2 codes, upper case. A country belongs to at most one market
  -- (enforced by the trigger below).
  countries  text[] NOT NULL CHECK (cardinality(countries) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.markets ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.markets IS
  'Markets the game knows. A player belongs to the market that lists their country; content is for all markets unless it names one.';

CREATE FUNCTION public.markets_check_countries() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM unnest(NEW.countries) AS c WHERE c !~ '^[A-Z]{2}$') THEN
    RAISE EXCEPTION 'markets.countries must hold upper-case ISO 3166-1 alpha-2 codes';
  END IF;
  -- Every other market. On an update the row's own stored version is left out
  -- by its old code, so a market can be renamed.
  IF EXISTS (
    SELECT 1 FROM public.markets m
    WHERE m.code <> NEW.code
      AND (TG_OP = 'INSERT' OR m.code <> OLD.code)
      AND m.countries && NEW.countries
  ) THEN
    RAISE EXCEPTION 'a country can belong to only one market';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER markets_check_countries
  BEFORE INSERT OR UPDATE ON public.markets
  FOR EACH ROW EXECUTE FUNCTION public.markets_check_countries();

INSERT INTO public.markets (code, name, countries) VALUES
  ('ge', 'Georgia',        ARRAY['GE']),
  ('tr', 'Turkey',         ARRAY['TR']),
  ('ar', 'Argentina',      ARRAY['AR']),
  ('uk', 'United Kingdom', ARRAY['GB']),
  ('es', 'Spain',          ARRAY['ES']);

ALTER TABLE public.categories
  ADD COLUMN market      text REFERENCES public.markets(code) ON UPDATE CASCADE ON DELETE RESTRICT,
  ADD COLUMN market_only boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT categories_market_only_needs_market CHECK (NOT market_only OR market IS NOT NULL);

COMMENT ON COLUMN public.categories.market IS
  'Home market. NULL = for all markets. With a market set, everyone can still play the category; players in that market get it more often.';
COMMENT ON COLUMN public.categories.market_only IS
  'true = only players in the home market are offered this category.';

-- HQ has kept its own market labels so far (harness.category_markets). Carry them
-- over as home markets; nothing becomes market-only by itself. HQ moves to these
-- columns in its own change.
DO $$
BEGIN
  IF to_regclass('harness.category_markets') IS NOT NULL THEN
    UPDATE public.categories c
    SET market = cm.market
    FROM harness.category_markets cm
    WHERE cm.category_id = c.id
      AND EXISTS (SELECT 1 FROM public.markets m WHERE m.code = cm.market);
  END IF;
END;
$$;
