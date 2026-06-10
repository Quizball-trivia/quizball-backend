-- Ticket economy v3:
--  - Maximum wallet tickets raised 3 → 5 (refill stays +1 per 4h, now up to 5).
--  - Store sells three coin-priced packs: 1 ticket / 2,000, 3 / 4,000, 5 / 5,000.
--  - Daily purchase cap is now QUANTITY based: up to 5 tickets per rolling 24h
--    window (was 3 single-ticket packs). Enforced in code
--    (store.service.ts TICKET_PURCHASE_MAX_TICKETS_PER_WINDOW).

-- 1) Raise the wallet cap. No clamping needed (cap goes up), but users who sat
--    at the old 3-ticket cap have tickets_refill_started_at = NULL ("full,
--    refill stopped") — restart their refill anchor or they would never climb
--    to the new cap.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_tickets_max_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_tickets_max_check CHECK (tickets <= 5);

ALTER TABLE public.users
  ALTER COLUMN tickets SET DEFAULT 5;

UPDATE public.users
SET tickets_refill_started_at = now()
WHERE tickets < 5
  AND tickets_refill_started_at IS NULL;

-- 2) Activate the three coin-priced ticket packs at the new prices.
--    (Rows already exist from 20260512120000_ticket_pack_economy.sql;
--     20260608144500_ticket_purchase_limits.sql had deactivated all but _1.)
UPDATE public.store_products
SET
  price_cents = 2000,
  currency = 'coins',
  metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tickets}', '1'::jsonb, true),
  is_active = true,
  sort_order = 50
WHERE slug = 'ticket_pack_1';

UPDATE public.store_products
SET
  price_cents = 4000,
  currency = 'coins',
  metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tickets}', '3'::jsonb, true),
  is_active = true,
  sort_order = 51
WHERE slug = 'ticket_pack_3';

UPDATE public.store_products
SET
  price_cents = 5000,
  currency = 'coins',
  metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tickets}', '5'::jsonb, true),
  is_active = true,
  sort_order = 52
WHERE slug = 'ticket_pack_5';

-- Any other ticket pack (e.g. legacy ticket_pack_10 / _25) stays inactive.
UPDATE public.store_products
SET is_active = false
WHERE type = 'ticket_pack'
  AND slug NOT IN ('ticket_pack_1', 'ticket_pack_3', 'ticket_pack_5');
