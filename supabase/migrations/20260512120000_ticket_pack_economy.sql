-- Switch ticket packs to a coin-priced economy with 1/3/5/10 tiers.
--
-- Rationale: tickets are now an in-game soft currency item, never charged in
-- USD. Players spend coins (which can be bought with USD or earned) on tickets.
-- For non-coin_pack products, `store_products.price_cents` is interpreted as
-- the coin cost (see store.service.ts → buyWithCoins). The `currency` column
-- is set to 'coins' on these rows for semantic clarity.
--
-- Coin pricing math (target: 1 ticket ≈ $0.50 at the entry coin-pack rate of
-- ~100 coins/$):
--   1  ticket  →  50  coins   (no bundle discount)
--   3  tickets → 140  coins   (~7% bundle discount)
--   5  tickets → 225  coins   (10%)
--  10  tickets → 425  coins   (15% — best value, fills the 10-ticket cap)

-- Deactivate the legacy 25-pack. Rows are kept so historical purchases retain
-- their FK to store_products. ticket_pack_3 and ticket_pack_10 are repurposed
-- below at the new coin-priced tiers.
UPDATE public.store_products
SET is_active = false
WHERE slug = 'ticket_pack_25';

-- Repurpose the existing ticket_pack_10 row to be the new "full refill" tier.
UPDATE public.store_products
SET
  name = '{"en":"10 Arena Tickets — Full Refill"}'::jsonb,
  description = '{"en":"Top up to the 10-ticket cap"}'::jsonb,
  price_cents = 425,
  currency = 'coins',
  metadata = '{"tickets":10}'::jsonb,
  is_active = true,
  sort_order = 53
WHERE slug = 'ticket_pack_10';

-- Insert the smaller tiers.
INSERT INTO public.store_products
  (slug, type, name, description, price_cents, currency, metadata, is_active, sort_order)
VALUES
  ('ticket_pack_1', 'ticket_pack',
    '{"en":"1 Arena Ticket"}'::jsonb,
    '{"en":"Single ticket top-up"}'::jsonb,
    50, 'coins', '{"tickets":1}'::jsonb, true, 50),
  ('ticket_pack_3', 'ticket_pack',
    '{"en":"3 Arena Tickets"}'::jsonb,
    '{"en":"Small ticket pack"}'::jsonb,
    140, 'coins', '{"tickets":3}'::jsonb, true, 51),
  ('ticket_pack_5', 'ticket_pack',
    '{"en":"5 Arena Tickets"}'::jsonb,
    '{"en":"Mid ticket pack"}'::jsonb,
    225, 'coins', '{"tickets":5}'::jsonb, true, 52)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_cents = EXCLUDED.price_cents,
  currency = EXCLUDED.currency,
  metadata = EXCLUDED.metadata,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order;
