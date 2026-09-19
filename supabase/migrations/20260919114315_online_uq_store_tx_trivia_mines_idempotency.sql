-- Build on the shared table without holding a write-blocking table lock.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_store_tx_trivia_mines_idempotency
  ON public.store_transaction_logs (event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND outcome = 'success'
    AND event_type IN ('trivia_mines_stake', 'trivia_mines_payout', 'trivia_mines_refund');
