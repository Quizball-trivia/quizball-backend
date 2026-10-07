-- Backend-only push state. No client may read tokens or bypass consent checks.
CREATE TABLE public.mobile_push_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_fingerprint text NOT NULL UNIQUE,
  token_encrypted text NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  -- Monotonic client ordering fences delayed registration after logout.
  client_revision bigint NOT NULL CHECK (client_revision > 0),
  platform text NOT NULL CHECK (platform IN ('ios','android')),
  locale text NOT NULL CHECK (locale IN ('en','ka','es','tr')),
  timezone text NOT NULL DEFAULT 'UTC',
  active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mobile_push_devices_owner ON public.mobile_push_devices(user_id) WHERE active;
CREATE TABLE public.mobile_push_preferences (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  match_invites_enabled boolean NOT NULL DEFAULT false,
  daily_reminders_enabled boolean NOT NULL DEFAULT false,
  new_games_enabled boolean NOT NULL DEFAULT false,
  daily_reminder_hour integer NOT NULL DEFAULT 19 CHECK (daily_reminder_hour BETWEEN 0 AND 23),
  timezone text NOT NULL DEFAULT 'UTC',
  consent_epoch bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.mobile_push_consent_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  choices jsonb NOT NULL,
  policy_version text NOT NULL DEFAULT 'push-v1',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.mobile_push_campaigns (
  id uuid PRIMARY KEY,
  created_by uuid NOT NULL REFERENCES public.users(id),
  title jsonb NOT NULL,
  body jsonb NOT NULL,
  route text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE TABLE public.mobile_push_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('daily','new_games','test')),
  local_day date NOT NULL,
  source_key text NOT NULL,
  consent_epoch bigint NOT NULL,
  title jsonb NOT NULL,
  body jsonb NOT NULL,
  route text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  UNIQUE(user_id, category, source_key)
);
CREATE UNIQUE INDEX mobile_push_event_daily_cap ON public.mobile_push_events(user_id, category, local_day) WHERE category <> 'test';
CREATE TABLE public.mobile_push_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.mobile_push_events(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES public.mobile_push_devices(id) ON DELETE CASCADE,
  device_generation bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','ticketed','provider_accepted','cancelled','failed','unknown')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  ticket_id text,
  ticketed_at timestamptz,
  receipt_checks integer NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id, device_id, device_generation)
);
CREATE INDEX mobile_push_jobs_due ON public.mobile_push_jobs(next_attempt_at) WHERE status IN ('pending','sending','ticketed');
CREATE INDEX mobile_push_events_source ON public.mobile_push_events(source_key);
CREATE INDEX mobile_push_events_retention ON public.mobile_push_events(created_at);
CREATE INDEX mobile_push_devices_retention ON public.mobile_push_devices(last_seen_at);
-- Shared circuit across workers/replicas, and a pin preventing accidental
-- fingerprint-key rotation from duplicating/reassigning physical devices.
CREATE TABLE public.mobile_push_provider_state (
  id text PRIMARY KEY CHECK(id = 'expo'),
  fingerprint_key_identity text NOT NULL,
  backoff_until timestamptz NOT NULL DEFAULT now(),
  error_code text
);
ALTER TABLE public.mobile_push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mobile_push_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mobile_push_consent_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mobile_push_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mobile_push_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mobile_push_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mobile_push_provider_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mobile_push_devices, public.mobile_push_preferences, public.mobile_push_consent_log,
  public.mobile_push_campaigns, public.mobile_push_events, public.mobile_push_jobs, public.mobile_push_provider_state FROM PUBLIC, anon, authenticated;
