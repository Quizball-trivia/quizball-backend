-- The quiz-page agent's work list and its operation journal.
--   campaign_quiz_backlog   pages to build in priority order. A runner claims one item and gets a fresh lease token;
--                           only that token can renew, checkpoint, finish or fail the item, and the backend's publish
--                           checks it inside its own transaction, so a runner that lost its lease can never publish.
--                           Every claim (also a takeover after a crash) counts as an attempt; past the cap the item is
--                           held for a person.
--   campaign_quiz_agent_ops every write the agent sends, stored before sending as the exact request text and its hash.
--                           Identity and request never change; status moves pending -> committed | failed once. One
--                           open operation per work item, so a takeover settles it before building anything new.
CREATE TABLE public.campaign_quiz_backlog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_slug text NOT NULL UNIQUE CHECK (char_length(page_slug) <= 80 AND page_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('team', 'national', 'league', 'quiz_type')),
  markets text[] NOT NULL DEFAULT '{}',
  priority integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'building', 'published', 'held', 'skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  not_before timestamptz,
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  stage text,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint) = 'object'),
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_campaign_quiz_backlog_lease CHECK (
    (status = 'building') = (lease_owner IS NOT NULL)
    AND (lease_owner IS NULL) = (lease_token IS NULL)
    AND (lease_owner IS NULL) = (lease_expires_at IS NULL)
  )
);

CREATE INDEX idx_campaign_quiz_backlog_next ON public.campaign_quiz_backlog (priority, created_at)
  WHERE status IN ('queued', 'building');

CREATE TRIGGER trg_campaign_quiz_backlog_set_updated_at
  BEFORE UPDATE ON public.campaign_quiz_backlog
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE public.campaign_quiz_agent_ops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backlog_id uuid REFERENCES public.campaign_quiz_backlog(id) ON DELETE SET NULL,
  quiz_slug text NOT NULL CHECK (quiz_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  kind text NOT NULL CHECK (kind IN ('create', 'refresh', 'review')),
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 16 AND 128 AND idempotency_key ~ '^[A-Za-z0-9:._-]+$'),
  request_text text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed', 'failed')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_campaign_quiz_agent_ops_one_open ON public.campaign_quiz_agent_ops (backlog_id)
  WHERE status = 'pending' AND backlog_id IS NOT NULL;
CREATE INDEX idx_campaign_quiz_agent_ops_slug ON public.campaign_quiz_agent_ops (quiz_slug, created_at DESC);

CREATE OR REPLACE FUNCTION public.campaign_quiz_agent_op_written()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.quiz_slug IS DISTINCT FROM OLD.quiz_slug
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.request_text IS DISTINCT FROM OLD.request_text
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (NEW.backlog_id IS DISTINCT FROM OLD.backlog_id AND NEW.backlog_id IS NOT NULL) THEN
    RAISE EXCEPTION 'campaign_quiz_agent_ops: an operation''s identity and request never change';
  END IF;
  IF OLD.status <> 'pending' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.response IS DISTINCT FROM OLD.response) THEN
    RAISE EXCEPTION 'campaign_quiz_agent_ops: a settled operation stays settled';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.campaign_quiz_agent_op_written() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_campaign_quiz_agent_op_written
  BEFORE UPDATE ON public.campaign_quiz_agent_ops
  FOR EACH ROW EXECUTE FUNCTION public.campaign_quiz_agent_op_written();

-- The next item: queued and due, or building with an expired lease (a crashed runner). Past p_max_attempts claims an
-- item is held instead. Leases use the wall clock, not the transaction start.
CREATE OR REPLACE FUNCTION public.claim_campaign_quiz_backlog(p_owner text, p_lease_seconds integer, p_max_attempts integer)
RETURNS SETOF public.campaign_quiz_backlog
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  candidate public.campaign_quiz_backlog;
BEGIN
  IF coalesce(btrim(p_owner), '') = '' THEN RAISE EXCEPTION 'claim: owner is required'; END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 7200 THEN RAISE EXCEPTION 'claim: lease must be 30..7200 s'; END IF;
  IF p_max_attempts IS NULL OR p_max_attempts NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'claim: max attempts must be 1..20'; END IF;
  LOOP
    SELECT * INTO candidate FROM public.campaign_quiz_backlog item
    WHERE (item.status = 'queued' AND (item.not_before IS NULL OR item.not_before <= clock_timestamp()))
       OR (item.status = 'building' AND item.lease_expires_at < clock_timestamp())
    ORDER BY item.priority, item.created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN; END IF;
    IF candidate.attempts >= p_max_attempts THEN
      UPDATE public.campaign_quiz_backlog
      SET status = 'held', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          last_error = coalesce(last_error, '') || ' [held after ' || candidate.attempts || ' attempts]'
      WHERE id = candidate.id;
      CONTINUE;
    END IF;
    RETURN QUERY
    UPDATE public.campaign_quiz_backlog
    SET status = 'building', attempts = attempts + 1, lease_owner = btrim(p_owner), lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds), not_before = NULL
    WHERE id = candidate.id
    RETURNING *;
    RETURN;
  END LOOP;
END;
$$;

-- Renews the lease and records progress; false when the claim is no longer this runner's (stop working on it).
CREATE OR REPLACE FUNCTION public.heartbeat_campaign_quiz_backlog(
  p_id uuid, p_token uuid, p_lease_seconds integer, p_stage text, p_checkpoint jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 7200 THEN RAISE EXCEPTION 'heartbeat: lease must be 30..7200 s'; END IF;
  UPDATE public.campaign_quiz_backlog
  SET lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      stage = coalesce(p_stage, stage),
      checkpoint = coalesce(p_checkpoint, checkpoint)
  WHERE id = p_id AND lease_token = p_token AND status = 'building' AND lease_expires_at > clock_timestamp();
  RETURN FOUND;
END;
$$;

-- Ends the claim: back in the queue after p_retry_seconds, or held once p_max_attempts claims are used.
CREATE OR REPLACE FUNCTION public.fail_campaign_quiz_backlog(
  p_id uuid, p_token uuid, p_error text, p_retry_seconds integer, p_max_attempts integer
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.campaign_quiz_backlog
  SET status = CASE WHEN attempts >= p_max_attempts THEN 'held' ELSE 'queued' END,
      not_before = CASE WHEN attempts >= p_max_attempts THEN NULL ELSE clock_timestamp() + make_interval(secs => greatest(p_retry_seconds, 0)) END,
      last_error = left(p_error, 2000),
      lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
  WHERE id = p_id AND lease_token = p_token AND status = 'building';
  RETURN FOUND;
END;
$$;

-- Ends a claim whose page needs no publish (skipped by policy); a published page is finished by the backend commit.
CREATE OR REPLACE FUNCTION public.skip_campaign_quiz_backlog(p_id uuid, p_token uuid, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.campaign_quiz_backlog
  SET status = 'skipped', last_error = left(p_reason, 2000), lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
  WHERE id = p_id AND lease_token = p_token AND status = 'building';
  RETURN FOUND;
END;
$$;

ALTER TABLE public.campaign_quiz_backlog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_quiz_agent_ops ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.campaign_quiz_backlog FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.campaign_quiz_agent_ops FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_campaign_quiz_backlog(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_campaign_quiz_backlog(uuid, uuid, integer, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_campaign_quiz_backlog(uuid, uuid, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.skip_campaign_quiz_backlog(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- The agent runner talks to these through the service role; grant what it needs explicitly.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE public.campaign_quiz_backlog TO service_role;
    GRANT SELECT, INSERT, UPDATE ON TABLE public.campaign_quiz_agent_ops TO service_role;
    GRANT EXECUTE ON FUNCTION public.claim_campaign_quiz_backlog(text, integer, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION public.heartbeat_campaign_quiz_backlog(uuid, uuid, integer, text, jsonb) TO service_role;
    GRANT EXECUTE ON FUNCTION public.fail_campaign_quiz_backlog(uuid, uuid, text, integer, integer) TO service_role;
    GRANT EXECUTE ON FUNCTION public.skip_campaign_quiz_backlog(uuid, uuid, text) TO service_role;
  END IF;
END $$;
