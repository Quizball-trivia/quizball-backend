-- Phone auth support for Georgian SMS login/linking.
-- `phone_number` is private profile data used to associate Supabase phone
-- identities with a QuizBall user. The partial unique index allows deleted
-- accounts and AI rows to stay out of the active human namespace.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS phone_number TEXT,
  ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_phone_number_active
  ON public.users (phone_number)
  WHERE phone_number IS NOT NULL
    AND is_ai = false
    AND is_deleted = false
    AND deleted_at IS NULL
    AND pending_deletion_at IS NULL;

CREATE TABLE IF NOT EXISTS public.sms_delivery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL DEFAULT 'smsoffice',
  message_type TEXT NOT NULL DEFAULT 'otp',
  reference TEXT NOT NULL UNIQUE,
  destination TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  error_code INTEGER,
  error_message TEXT,
  raw_callback JSONB,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_delivery_events_destination_created
  ON public.sms_delivery_events (destination, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sms_delivery_events_status_created
  ON public.sms_delivery_events (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_sms_delivery_events_set_updated_at ON public.sms_delivery_events;
CREATE TRIGGER trg_sms_delivery_events_set_updated_at
  BEFORE UPDATE ON public.sms_delivery_events
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();
