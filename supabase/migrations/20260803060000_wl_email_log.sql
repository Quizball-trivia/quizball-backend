-- Per-recipient email idempotency + retry state for Weekend League
-- reminder waves. sent_at NULL = attempted but not delivered; the wave
-- retries such rows until the attempt cap, so dead addresses can never
-- starve the candidate window. Cascade matches the other user-owned rows.
CREATE TABLE IF NOT EXISTS wl_email_log (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_event_key text NOT NULL,
  sent_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source_event_key)
);

ALTER TABLE wl_email_log ENABLE ROW LEVEL SECURITY;
