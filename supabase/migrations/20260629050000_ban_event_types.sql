-- Allow ban/unban admin actions to be recorded in the store_transaction_logs
-- audit table. The account-ban feature (migration 20260628120000_user_ban.sql)
-- writes 'admin_account_ban' / 'admin_account_unban' transaction-log rows, but
-- those values were not in the event_type CHECK constraint, so the INSERT failed
-- and the ban endpoint 500'd. Extends the CHECK with the two new values
-- (re-declares the full allowed set, mirroring prior event-type migrations).

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
      'leaderboard_reset',
      'admin_ticket_window_reset',
      'admin_account_ban',
      'admin_account_unban'
    )
  );
