-- Freecroco score events (contract v1.1 §6): an outbox row per finished partner play, written in the transaction that
-- finishes the play, and every delivery attempt of it. Server-only: never readable through the Data API.
-- play_id has no foreign key on purpose: the plays table belongs to the partner core migration, and the event must
-- survive whatever happens to the play row.

CREATE TABLE IF NOT EXISTS public.partner_score_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL UNIQUE CHECK (event_id ~ '^qb_[0-9a-f-]{36}$'),
  partner_slug text NOT NULL CHECK (partner_slug ~ '^[a-z][a-z0-9-]{1,31}$'),
  environment text NOT NULL CHECK (environment IN ('test', 'production')),
  play_id uuid NOT NULL UNIQUE,
  player_id text NOT NULL CHECK (player_id ~ '^[A-Za-z0-9._:@-]{1,64}$'),
  session_id uuid NOT NULL,
  game_id text NOT NULL CHECK (game_id ~ '^[a-z][a-z-]{1,31}$'),
  score integer NOT NULL CHECK (score >= 0),
  occurred_at timestamptz NOT NULL,
  -- The contract body exactly as it is sent, frozen at enqueue.
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  -- Where its first attempt went (origin + hash of the URL); it is sent nowhere else unless resent by hand.
  destination text CHECK (destination IS NULL OR char_length(destination) <= 300),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  sent_at timestamptz,
  dead_at timestamptz,
  -- A manual resend: the 24-hour retry window starts again here.
  revived_at timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_score_events_event_matches_play CHECK (event_id = 'qb_' || play_id::text),
  CONSTRAINT partner_score_events_lease_pair CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

-- Due rows (the dispatcher's claim) and the sends in flight (the global concurrency cap).
CREATE INDEX IF NOT EXISTS partner_score_events_due
  ON public.partner_score_events (partner_slug, environment, next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS partner_score_events_leased
  ON public.partner_score_events (lease_expires_at) WHERE status = 'pending' AND lease_token IS NOT NULL;
-- The status endpoint's oldest undelivered event, aged from the start of its retry window.
CREATE INDEX IF NOT EXISTS partner_score_events_pending_age
  ON public.partner_score_events (partner_slug, (coalesce(revived_at, created_at))) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS partner_score_events_dead
  ON public.partner_score_events (partner_slug, dead_at) WHERE status = 'dead';
-- The player's recent results and the admin listing (newest first, filtered).
CREATE INDEX IF NOT EXISTS partner_score_events_player
  ON public.partner_score_events (partner_slug, player_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS partner_score_events_listing
  ON public.partner_score_events (partner_slug, id DESC);

-- The event never changes: only its delivery state moves. Rows are kept.
CREATE OR REPLACE FUNCTION public.partner_score_events_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'partner_score_events rows are kept';
  END IF;
  IF (NEW.id, NEW.event_id, NEW.partner_slug, NEW.environment, NEW.play_id, NEW.player_id, NEW.session_id,
      NEW.game_id, NEW.score, NEW.occurred_at, NEW.payload, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.event_id, OLD.partner_slug, OLD.environment, OLD.play_id, OLD.player_id, OLD.session_id,
      OLD.game_id, OLD.score, OLD.occurred_at, OLD.payload, OLD.created_at) THEN
    RAISE EXCEPTION 'a partner score event never changes';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS partner_score_events_frozen ON public.partner_score_events;
CREATE TRIGGER partner_score_events_frozen BEFORE UPDATE OR DELETE ON public.partner_score_events
  FOR EACH ROW EXECUTE FUNCTION public.partner_score_events_frozen();
DROP TRIGGER IF EXISTS partner_score_events_no_truncate ON public.partner_score_events;
CREATE TRIGGER partner_score_events_no_truncate BEFORE TRUNCATE ON public.partner_score_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.partner_score_events_frozen();

-- One row per attempt, written once: the HTTP status and our own classification of the outcome, never anything
-- from the answer's body or the URL. `lease_expired`: the sender never recorded an outcome before its lease ran out,
-- so the request may or may not have reached the partner. `dead_conflict`: a 409 (same eventId, different body).
CREATE TABLE IF NOT EXISTS public.partner_score_event_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_row_id bigint NOT NULL REFERENCES public.partner_score_events (id),
  attempt integer NOT NULL CHECK (attempt >= 1),
  started_at timestamptz NOT NULL,
  latency_ms integer CHECK (latency_ms >= 0),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  error text CHECK (error IN ('timeout', 'dns', 'refused', 'reset', 'tls', 'network', 'aborted', 'lease_expired',
                              'dead_conflict') OR error ~ '^http_[1-5][0-9]{2}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A 2xx is the only outcome without an error; no answer at all always has one.
  CONSTRAINT partner_score_event_attempts_outcome CHECK (
    CASE WHEN http_status BETWEEN 200 AND 299 THEN error IS NULL ELSE error IS NOT NULL END)
);
CREATE INDEX IF NOT EXISTS partner_score_event_attempts_event
  ON public.partner_score_event_attempts (event_row_id, id);

CREATE OR REPLACE FUNCTION public.partner_score_event_attempts_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'partner_score_event_attempts is append-only';
END
$$;

DROP TRIGGER IF EXISTS partner_score_event_attempts_append_only ON public.partner_score_event_attempts;
CREATE TRIGGER partner_score_event_attempts_append_only BEFORE UPDATE OR DELETE ON public.partner_score_event_attempts
  FOR EACH ROW EXECUTE FUNCTION public.partner_score_event_attempts_append_only();
DROP TRIGGER IF EXISTS partner_score_event_attempts_no_truncate ON public.partner_score_event_attempts;
CREATE TRIGGER partner_score_event_attempts_no_truncate BEFORE TRUNCATE ON public.partner_score_event_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION public.partner_score_event_attempts_append_only();

-- Backend roles only (RLS without policies, no grants to any Data API role).
ALTER TABLE public.partner_score_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_score_event_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_score_events, public.partner_score_event_attempts FROM PUBLIC;
DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON public.partner_score_events, public.partner_score_event_attempts FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.partner_score_events_id_seq, public.partner_score_event_attempts_id_seq FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
