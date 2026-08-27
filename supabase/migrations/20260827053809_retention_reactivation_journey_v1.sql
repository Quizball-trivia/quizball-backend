-- Durable, server-owned reactivation journey state. The journey is separate
-- from the completed one-shot dormant email experiment: it gives every
-- inactivity episode one stable experiment assignment and records each due
-- milestone exactly once.

CREATE TABLE public.retention_journey_configs (
  journey_key text PRIMARY KEY,
  version integer NOT NULL CHECK (version > 0),
  feature_flag_key text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'canary', 'live', 'paused', 'completed')
  ),
  assignment_cap integer NOT NULL DEFAULT 0 CHECK (assignment_cap BETWEEN 0 AND 10000),
  daily_assignment_cap integer NOT NULL DEFAULT 50 CHECK (daily_assignment_cap BETWEEN 1 AND 1000),
  daily_send_cap integer NOT NULL DEFAULT 25 CHECK (daily_send_cap BETWEEN 1 AND 1000),
  min_lifetime_matches integer NOT NULL DEFAULT 1 CHECK (min_lifetime_matches BETWEEN 1 AND 1000),
  quiet_hours_start smallint NOT NULL DEFAULT 21 CHECK (quiet_hours_start BETWEEN 0 AND 23),
  quiet_hours_end smallint NOT NULL DEFAULT 10 CHECK (quiet_hours_end BETWEEN 0 AND 23),
  email_frequency_days integer NOT NULL DEFAULT 7 CHECK (email_frequency_days BETWEEN 1 AND 90),
  sms_status text NOT NULL DEFAULT 'locked' CHECK (sms_status IN ('locked', 'paused', 'live')),
  updated_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.retention_journey_configs (
  journey_key,
  version,
  feature_flag_key,
  status,
  assignment_cap,
  daily_assignment_cap,
  daily_send_cap
) VALUES (
  'dormant_reactivation',
  1,
  'dormant-reactivation-journey-v1',
  'draft',
  0,
  50,
  25
);

CREATE TABLE public.retention_journey_enrollments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journey_key text NOT NULL REFERENCES public.retention_journey_configs(journey_key),
  journey_version integer NOT NULL CHECK (journey_version > 0),
  feature_flag_key text NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  variant text NOT NULL CHECK (variant IN ('control', 'test')),
  baseline_last_match_started_at timestamptz NOT NULL,
  entry_milestone_days integer NOT NULL CHECK (entry_milestone_days IN (3, 7, 14, 30, 60)),
  entered_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exited', 'completed')),
  exited_at timestamptz,
  exit_reason text CHECK (
    exit_reason IS NULL OR exit_reason IN (
      'returned', 'unsubscribed', 'user_ineligible', 'journey_paused', 'journey_completed'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_retention_journey_episode
    UNIQUE (journey_key, journey_version, user_id, baseline_last_match_started_at),
  CONSTRAINT chk_retention_journey_exit_shape CHECK (
    (status = 'active' AND exited_at IS NULL AND exit_reason IS NULL)
    OR (status IN ('exited', 'completed') AND exited_at IS NOT NULL AND exit_reason IS NOT NULL)
  )
);

CREATE INDEX idx_retention_journey_enrollments_active
  ON public.retention_journey_enrollments (journey_key, entered_at, id)
  WHERE status = 'active';

CREATE INDEX idx_retention_journey_enrollments_user
  ON public.retention_journey_enrollments (user_id, entered_at DESC);

-- Extend the existing provider-safe delivery ledger for journey milestones.
ALTER TABLE public.retention_email_assignments
  DROP CONSTRAINT retention_email_assignments_message_kind_check,
  DROP CONSTRAINT retention_email_assignments_destination_path_check,
  DROP CONSTRAINT chk_retention_email_campaign_shape;

ALTER TABLE public.retention_email_assignments
  ADD COLUMN journey_enrollment_id uuid
    REFERENCES public.retention_journey_enrollments(id) ON DELETE CASCADE,
  ADD COLUMN milestone_days integer CHECK (milestone_days IN (3, 7, 14, 30, 60)),
  ADD COLUMN scheduled_for timestamptz,
  ADD CONSTRAINT retention_email_assignments_message_kind_check
    CHECK (message_kind IN ('weekend_league', 'dormant_comeback', 'dormant_journey')),
  ADD CONSTRAINT retention_email_assignments_destination_path_check
    CHECK (destination_path IN ('/play', '/weekend-league', '/daily/challenges', '/auction')),
  ADD CONSTRAINT chk_retention_email_campaign_shape CHECK (
    (message_kind = 'weekend_league' AND tournament_id IS NOT NULL
      AND cta_state IN ('qualifying', 'qualified') AND journey_enrollment_id IS NULL
      AND milestone_days IS NULL)
    OR
    (message_kind = 'dormant_comeback' AND tournament_id IS NULL
      AND cta_state = 'comeback' AND destination_path = '/play' AND qp_remaining = 0
      AND journey_enrollment_id IS NULL AND milestone_days IS NULL)
    OR
    (message_kind = 'dormant_journey' AND tournament_id IS NULL
      AND cta_state = 'comeback' AND qp_remaining = 0
      AND journey_enrollment_id IS NOT NULL AND milestone_days IS NOT NULL
      AND scheduled_for IS NOT NULL)
  );

CREATE UNIQUE INDEX uq_retention_email_journey_milestone
  ON public.retention_email_assignments (journey_enrollment_id, milestone_days)
  WHERE journey_enrollment_id IS NOT NULL;

CREATE INDEX idx_retention_email_assignments_scheduled_pending
  ON public.retention_email_assignments (scheduled_for, id)
  WHERE send_status = 'pending';

-- Phone verification proves possession, not consent to receive marketing SMS.
-- This table intentionally defaults SMS to not opted in; the journey cannot
-- use the mobile channel until a separate consent and STOP flow writes here.
CREATE TABLE public.marketing_channel_preferences (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  sms_marketing_opted_in boolean NOT NULL DEFAULT false,
  sms_marketing_consented_at timestamptz,
  sms_marketing_consent_source text,
  sms_marketing_opted_out_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_sms_marketing_consent CHECK (
    (sms_marketing_opted_in = false)
    OR (sms_marketing_consented_at IS NOT NULL AND sms_marketing_opted_out_at IS NULL)
  )
);

ALTER TABLE public.retention_journey_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retention_journey_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_channel_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retention_email_assignments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.retention_journey_configs FROM anon, authenticated;
REVOKE ALL ON TABLE public.retention_journey_enrollments FROM anon, authenticated;
REVOKE ALL ON TABLE public.marketing_channel_preferences FROM anon, authenticated;
REVOKE ALL ON TABLE public.retention_email_assignments FROM anon, authenticated;

CREATE TRIGGER trg_retention_journey_configs_set_updated_at
  BEFORE UPDATE ON public.retention_journey_configs
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

CREATE TRIGGER trg_retention_journey_enrollments_set_updated_at
  BEFORE UPDATE ON public.retention_journey_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

CREATE TRIGGER trg_marketing_channel_preferences_set_updated_at
  BEFORE UPDATE ON public.marketing_channel_preferences
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

COMMENT ON TABLE public.retention_journey_configs IS
  'Backend-only safety and rollout configuration for durable reactivation journeys.';
COMMENT ON TABLE public.retention_journey_enrollments IS
  'One stable experiment assignment per player inactivity episode; no recipient PII is stored.';
COMMENT ON TABLE public.marketing_channel_preferences IS
  'Explicit channel consent ledger. A verified phone alone never enables marketing SMS.';
