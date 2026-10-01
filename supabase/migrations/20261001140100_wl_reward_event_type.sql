-- Wallet ledger event for Weekend League reward payouts. Swap is NOT VALID so
-- it does not scan the table under the exclusive lock; the next migration
-- validates it.
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
      'admin_account_unban',
      'free_kicks_stake',
      'free_kicks_payout',
      'guess_the_goal_reward',
      'road_to_goal_stake',
      'road_to_goal_payout',
      'trivia_mines_stake',
      'trivia_mines_payout',
      'trivia_mines_refund',
      'squad_spin_stake',
      'squad_spin_payout',
      'squad_spin_refund',
      'wl_reward'
    )
  ) NOT VALID;
