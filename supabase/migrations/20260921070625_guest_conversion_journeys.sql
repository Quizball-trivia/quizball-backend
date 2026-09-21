-- Additive analytics only. No balances, account identities or game state are moved.
-- Deliberately no FK to guest_sessions: its 45-day cleanup must not erase attribution.
CREATE TABLE public.guest_journeys (
  guest_id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  guest_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  country text,
  locale text,
  first_play_at timestamptz,
  first_mode text,
  linked_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  linked_at timestamptz,
  link_type text CHECK (link_type IN ('signup', 'existing_member')),
  CHECK ((linked_at IS NULL) = (link_type IS NULL))
);
CREATE INDEX guest_journeys_member_idx ON public.guest_journeys(linked_user_id) WHERE linked_user_id IS NOT NULL;
CREATE UNIQUE INDEX guest_journeys_signup_member_idx ON public.guest_journeys(linked_user_id) WHERE link_type = 'signup';
CREATE TABLE public.guest_journey_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid NOT NULL REFERENCES public.guest_journeys(guest_id) ON DELETE CASCADE,
  dedupe_key text NOT NULL,
  event text NOT NULL,
  properties jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  UNIQUE(guest_id, dedupe_key)
);
CREATE INDEX guest_journey_events_pending_idx ON public.guest_journey_events(next_attempt_at) WHERE delivered_at IS NULL;
ALTER TABLE public.guest_journeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guest_journey_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.guest_journeys, public.guest_journey_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.guest_journeys, public.guest_journey_events TO service_role;
