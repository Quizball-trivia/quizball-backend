-- Add index on stripe_payment_intent for webhook lookups
CREATE INDEX IF NOT EXISTS idx_store_purchases_stripe_payment_intent
  ON public.store_purchases (stripe_payment_intent)
  WHERE stripe_payment_intent IS NOT NULL;
