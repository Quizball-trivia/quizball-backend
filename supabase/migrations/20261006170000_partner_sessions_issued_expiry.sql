-- The janitor expires unused launch tokens every tick on every replica: without this it reads every open session.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE INDEX IF NOT EXISTS idx_partner_sessions_issued_expiry
  ON public.partner_sessions (token_expires_at)
  WHERE state = 'issued';
