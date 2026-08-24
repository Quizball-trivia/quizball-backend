-- Server-owned assignments and delivery state for the inactive-player
-- Weekend League comeback email experiment. Browser roles receive no grants;
-- the backend is the only writer and PostHog receives no email addresses.

CREATE TABLE public.retention_email_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_key text NOT NULL,
  feature_flag_key text NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  tournament_id uuid NOT NULL REFERENCES public.wl_tournaments(id) ON DELETE CASCADE,
  variant text NOT NULL CHECK (variant IN ('control', 'test')),
  cta_state text NOT NULL CHECK (cta_state IN ('qualifying', 'qualified')),
  destination_path text NOT NULL CHECK (destination_path IN ('/play', '/weekend-league')),
  qp_remaining integer NOT NULL CHECK (qp_remaining >= 0),
  last_match_started_at timestamptz NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  send_status text NOT NULL CHECK (
    send_status IN ('not_applicable', 'pending', 'sending', 'sent', 'failed', 'cancelled')
  ),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  provider_message_id text,
  delivery_status text NOT NULL DEFAULT 'unknown' CHECK (
    delivery_status IN ('unknown', 'delivered', 'delayed', 'bounced', 'failed', 'suppressed', 'complained')
  ),
  delivery_status_at timestamptz,
  delivered_at timestamptz,
  delivery_failed_at timestamptz,
  opened_at timestamptz,
  open_count integer NOT NULL DEFAULT 0 CHECK (open_count >= 0),
  clicked_at timestamptz,
  unsubscribed_at timestamptz,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_retention_email_assignment_campaign_tournament_user
    UNIQUE (campaign_key, tournament_id, user_id),
  CONSTRAINT chk_retention_email_variant_status CHECK (
    (variant = 'control' AND send_status = 'not_applicable')
    OR variant = 'test'
  )
);

CREATE INDEX idx_retention_email_assignments_pending
  ON public.retention_email_assignments (assigned_at, id)
  WHERE send_status = 'pending';

CREATE INDEX idx_retention_email_assignments_user_recent
  ON public.retention_email_assignments (user_id, assigned_at DESC);

CREATE UNIQUE INDEX uq_retention_email_assignments_provider_message
  ON public.retention_email_assignments (provider_message_id)
  WHERE provider_message_id IS NOT NULL;

ALTER TABLE public.retention_email_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.retention_email_assignments FROM anon, authenticated;

CREATE TRIGGER trg_retention_email_assignments_set_updated_at
  BEFORE UPDATE ON public.retention_email_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

COMMENT ON TABLE public.retention_email_assignments IS
  'Backend-owned inactive-player email experiment assignments, delivery state, and non-PII attribution.';

CREATE TABLE public.email_provider_webhook_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  provider_message_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

ALTER TABLE public.email_provider_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.email_provider_webhook_events FROM anon, authenticated;

COMMENT ON TABLE public.email_provider_webhook_events IS
  'Idempotency ledger for signed provider webhooks associated with retention email assignments; payload and recipient address are not stored.';
