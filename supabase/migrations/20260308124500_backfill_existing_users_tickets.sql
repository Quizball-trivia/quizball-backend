UPDATE users
SET
  tickets = 10,
  tickets_refill_started_at = NULL
WHERE tickets < 10;
