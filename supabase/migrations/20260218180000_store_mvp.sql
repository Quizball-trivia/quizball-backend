-- Store + Stripe MVP schema
-- Includes:
-- - Wallet balances on users
-- - Store catalog / purchases / inventory
-- - Immutable store transaction log for reconciliation

-- =============================================================================
-- Users wallet columns
-- =============================================================================

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS coins integer NOT NULL DEFAULT 0;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS tickets integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_coins_nonneg'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_coins_nonneg CHECK (coins >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_tickets_nonneg'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_tickets_nonneg CHECK (tickets >= 0);
  END IF;
END $$;

-- =============================================================================
-- Store products
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.store_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  type text NOT NULL
    CHECK (type IN ('coin_pack', 'ticket_pack', 'avatar', 'chance_card')),
  name jsonb NOT NULL DEFAULT '{}'::jsonb,
  description jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_cents integer NOT NULL CHECK (price_cents > 0),
  currency text NOT NULL DEFAULT 'usd',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_store_products_type_active
  ON public.store_products (type, sort_order, created_at DESC)
  WHERE is_active = true;

-- =============================================================================
-- Store purchases
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.store_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.store_products(id) ON DELETE RESTRICT,
  stripe_checkout_id text UNIQUE,
  stripe_payment_intent text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed', 'refunded')),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'usd',
  fulfilled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_store_purchases_user
  ON public.store_purchases (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_store_purchases_stripe_checkout
  ON public.store_purchases (stripe_checkout_id)
  WHERE stripe_checkout_id IS NOT NULL;

-- =============================================================================
-- User inventory
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.user_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.store_products(id) ON DELETE RESTRICT,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_inventory_unique UNIQUE (user_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_user_inventory_user
  ON public.user_inventory (user_id, acquired_at DESC);

-- =============================================================================
-- Immutable store transaction logs (reconciliation + manual compensation audit)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.store_transaction_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (
    event_type IN (
      'checkout_session_created',
      'checkout_session_failed',
      'webhook_received',
      'webhook_signature_invalid',
      'fulfillment_succeeded',
      'fulfillment_failed',
      'manual_adjustment_succeeded',
      'manual_adjustment_failed'
    )
  ),
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure')),
  purchase_id uuid REFERENCES public.store_purchases(id) ON DELETE SET NULL,
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  product_id uuid REFERENCES public.store_products(id) ON DELETE SET NULL,
  stripe_checkout_id text,
  stripe_payment_intent text,
  coins_delta integer NOT NULL DEFAULT 0,
  tickets_delta integer NOT NULL DEFAULT 0,
  inventory_delta jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  error_code text,
  error_message text,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_store_transaction_logs_user_created
  ON public.store_transaction_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_store_transaction_logs_purchase
  ON public.store_transaction_logs (purchase_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_store_transaction_logs_event_outcome
  ON public.store_transaction_logs (event_type, outcome, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_store_tx_manual_adjustment_idempotency
  ON public.store_transaction_logs (idempotency_key)
  WHERE event_type = 'manual_adjustment_succeeded' AND idempotency_key IS NOT NULL;

-- =============================================================================
-- Seed baseline products (idempotent by slug)
-- =============================================================================

INSERT INTO public.store_products (slug, type, name, description, price_cents, currency, metadata, is_active, sort_order)
VALUES
  (
    'coin_pack_100',
    'coin_pack',
    '{"en":"100 Coins"}'::jsonb,
    '{"en":"Quick coin top-up"}'::jsonb,
    99,
    'usd',
    '{"coins":100}'::jsonb,
    true,
    10
  ),
  (
    'coin_pack_550',
    'coin_pack',
    '{"en":"550 Coins"}'::jsonb,
    '{"en":"Includes bonus coins"}'::jsonb,
    499,
    'usd',
    '{"coins":550,"bonusPercent":10}'::jsonb,
    true,
    20
  ),
  (
    'coin_pack_1200',
    'coin_pack',
    '{"en":"1200 Coins"}'::jsonb,
    '{"en":"Mid-tier coin bundle"}'::jsonb,
    999,
    'usd',
    '{"coins":1200,"bonusPercent":20}'::jsonb,
    true,
    30
  ),
  (
    'coin_pack_3000',
    'coin_pack',
    '{"en":"3000 Coins"}'::jsonb,
    '{"en":"High-value coin bundle"}'::jsonb,
    1999,
    'usd',
    '{"coins":3000,"bonusPercent":50}'::jsonb,
    true,
    40
  ),
  (
    'ticket_pack_3',
    'ticket_pack',
    '{"en":"3 Arena Tickets"}'::jsonb,
    '{"en":"Small ranked ticket pack"}'::jsonb,
    199,
    'usd',
    '{"tickets":3}'::jsonb,
    true,
    50
  ),
  (
    'ticket_pack_10',
    'ticket_pack',
    '{"en":"10 Arena Tickets"}'::jsonb,
    '{"en":"Most popular ticket pack"}'::jsonb,
    499,
    'usd',
    '{"tickets":10}'::jsonb,
    true,
    60
  ),
  (
    'ticket_pack_25',
    'ticket_pack',
    '{"en":"25 Arena Tickets"}'::jsonb,
    '{"en":"High-volume ticket bundle"}'::jsonb,
    999,
    'usd',
    '{"tickets":25,"bonusPercent":25}'::jsonb,
    true,
    70
  ),
  (
    'avatar_lion',
    'avatar',
    '{"en":"Lion Avatar"}'::jsonb,
    '{"en":"Show your pride with a lion avatar"}'::jsonb,
    299,
    'usd',
    '{"avatarKey":"lion","assetUrl":"/avatars/lion.png"}'::jsonb,
    true,
    80
  ),
  (
    'chance_card_5050',
    'chance_card',
    '{"en":"50-50 Chance Card"}'::jsonb,
    '{"en":"Remove two wrong options in ranked mode"}'::jsonb,
    199,
    'usd',
    '{"effect":"fifty_fifty"}'::jsonb,
    true,
    90
  )
ON CONFLICT (slug) DO UPDATE SET
  type = EXCLUDED.type,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_cents = EXCLUDED.price_cents,
  currency = EXCLUDED.currency,
  metadata = EXCLUDED.metadata,
  is_active = EXCLUDED.is_active,
  sort_order = EXCLUDED.sort_order;
