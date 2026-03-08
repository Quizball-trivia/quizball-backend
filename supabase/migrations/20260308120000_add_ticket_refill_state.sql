ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tickets_refill_started_at timestamptz;

UPDATE users
SET
  tickets = LEAST(GREATEST(tickets, 0), 10),
  tickets_refill_started_at = CASE
    WHEN LEAST(GREATEST(tickets, 0), 10) >= 10 THEN NULL
    ELSE NOW()
  END;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_tickets_max_check'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_tickets_max_check CHECK (tickets <= 10);
  END IF;
END $$;
