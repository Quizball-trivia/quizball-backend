-- Retried payout/stake writes must lose a unique-index race instead of moving
-- coins twice. CONCURRENTLY requires this migration to contain one statement.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_store_tx_road_to_goal_idempotency
  ON public.store_transaction_logs (event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND outcome = 'success'
    AND event_type IN ('road_to_goal_stake', 'road_to_goal_payout');
