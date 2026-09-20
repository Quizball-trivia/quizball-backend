-- Road to Goal and Guess the Goal were developed on parallel branches. Each
-- feature originally extended the same ledger CHECK from its own branch view,
-- so whichever migration ran last could remove the other game's event types.
-- Re-establish the union after both feature timestamps to make merge/deploy
-- order safe. Validation remains in a separate migration to keep the lock
-- profile explicit on the append-only ledger.

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
      'road_to_goal_payout'
    )
  ) NOT VALID;
