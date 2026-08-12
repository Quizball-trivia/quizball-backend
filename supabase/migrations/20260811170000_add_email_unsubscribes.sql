-- Marketing-email opt-outs. One row per user; transactional email (event
-- reminders for entrants, receipts) is out of scope. Service-role only.

CREATE TABLE IF NOT EXISTS email_unsubscribes (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT
);

ALTER TABLE email_unsubscribes ENABLE ROW LEVEL SECURITY;
