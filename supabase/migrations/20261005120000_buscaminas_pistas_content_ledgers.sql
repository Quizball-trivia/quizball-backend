-- What Buscaminas and Pistas ever published, on a daily day or in the duel pool. Duel packs are harvestable and
-- a daily's answers become public, so the days and the pool must never share a category (Buscaminas) or a player
-- (Pistas) — including content that was later corrected away or replaced in the pool, which the current tables
-- no longer show. Same shape and rules as ultimo_content_ledger / minuto_content_ledger. Additive, no locks.

CREATE TABLE IF NOT EXISTS public.buscaminas_content_ledger (
  id bigserial PRIMARY KEY,
  side text NOT NULL,
  -- the round's normalised Spanish prompt (the key the overlap checks compare)
  key text NOT NULL,
  -- the day that published it (days side only)
  day date,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_buscaminas_content_ledger_side CHECK (side IN ('day', 'pool')),
  CONSTRAINT chk_buscaminas_content_ledger_day CHECK ((side = 'day') = (day IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_buscaminas_content_ledger ON public.buscaminas_content_ledger (side, key, COALESCE(day, '1970-01-01'::date));

CREATE TABLE IF NOT EXISTS public.pistas_content_ledger (
  id bigserial PRIMARY KEY,
  side text NOT NULL,
  -- the player's display names and accepted answers (samePlayer compares them)
  display jsonb NOT NULL,
  accepted jsonb NOT NULL,
  -- normalised identity of the entry, so the same player is recorded once per side and day
  identity text NOT NULL,
  day date,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_pistas_content_ledger_side CHECK (side IN ('day', 'pool')),
  CONSTRAINT chk_pistas_content_ledger_day CHECK ((side = 'day') = (day IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pistas_content_ledger ON public.pistas_content_ledger (side, identity, COALESCE(day, '1970-01-01'::date));

-- Server-only (RLS without policies, no client grants): answers must never be readable through the Data API.
ALTER TABLE public.buscaminas_content_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pistas_content_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.buscaminas_content_ledger, public.pistas_content_ledger FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.buscaminas_content_ledger, public.pistas_content_ledger TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.buscaminas_content_ledger_id_seq, public.pistas_content_ledger_id_seq TO service_role;
