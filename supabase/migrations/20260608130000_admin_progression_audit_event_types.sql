-- Admin panel: allow progression (XP/RP) adjustments and leaderboard resets to be
-- recorded in the existing store_transaction_logs audit table. Extends the
-- event_type CHECK constraint with the two new admin event types.

ALTER TABLE public.store_transaction_logs
  DROP CONSTRAINT IF EXISTS store_transaction_logs_event_type_check;

ALTER TABLE public.store_transaction_logs
  ADD CONSTRAINT store_transaction_logs_event_type_check
  CHECK (
    event_type IN (
      'checkout_session_created',
      'checkout_session_failed',
      'webhook_received',
      'webhook_signature_invalid',
      'fulfillment_succeeded',
      'fulfillment_failed',
      'manual_adjustment_succeeded',
      'manual_adjustment_failed',
      'objective_reward_succeeded',
      'admin_progression_adjustment',
      'leaderboard_reset'
    )
  );
