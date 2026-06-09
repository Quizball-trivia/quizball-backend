-- Ticket economy update:
-- - Maximum wallet tickets is 3.
-- - Automatic refill remains capped at the maximum.
-- - Store sells only one ticket pack: 1 ticket for 2,000 coins.

UPDATE public.users
SET
  tickets = LEAST(GREATEST(tickets, 0), 3),
  tickets_refill_started_at = CASE
    WHEN LEAST(GREATEST(tickets, 0), 3) >= 3 THEN NULL
    ELSE tickets_refill_started_at
  END
WHERE tickets <> LEAST(GREATEST(tickets, 0), 3)
   OR (LEAST(GREATEST(tickets, 0), 3) >= 3 AND tickets_refill_started_at IS NOT NULL);

ALTER TABLE public.users
  ALTER COLUMN tickets SET DEFAULT 3;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_tickets_max_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_tickets_max_check CHECK (tickets <= 3);

UPDATE public.store_products
SET
  price_cents = 2000,
  currency = 'coins',
  metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{tickets}', '1'::jsonb, true),
  is_active = true,
  sort_order = 50
WHERE slug = 'ticket_pack_1';

UPDATE public.store_products
SET is_active = false
WHERE type = 'ticket_pack'
  AND slug <> 'ticket_pack_1';
