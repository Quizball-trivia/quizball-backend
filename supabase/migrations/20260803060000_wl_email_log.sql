-- Per-recipient email idempotency for Weekend League reminder waves.
-- Mirrors the in-app notifications' (user_id, source_event_key) contract:
-- a row here means THIS user was already sent THIS wave's email.
CREATE TABLE IF NOT EXISTS wl_email_log (
  user_id uuid NOT NULL REFERENCES users(id),
  source_event_key text NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, source_event_key)
);

ALTER TABLE wl_email_log ENABLE ROW LEVEL SECURITY;
