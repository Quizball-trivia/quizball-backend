-- The quiz-page agent's work list and its operation journal.
--   campaign_quiz_backlog   pages to build, in priority order; a runner leases one item at a time (lease_owner +
--                           lease_expires_at, renewed while it works) and keeps its progress in stage + checkpoint, so
--                           a crash resumes where it stopped instead of paying for the same work twice.
--   campaign_quiz_agent_ops every write the agent sends to the backend, frozen before it is sent: an uncertain outcome is
--                           retried with the same key and bytes, a new candidate gets a new key.
CREATE TABLE public.campaign_quiz_backlog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_slug text NOT NULL UNIQUE CHECK (char_length(page_slug) <= 80 AND page_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('team', 'national', 'league', 'quiz_type')),
  markets text[] NOT NULL DEFAULT '{}',
  priority integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'building', 'published', 'failed', 'held', 'skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  stage text,
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint) = 'object'),
  last_error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_campaign_quiz_backlog_lease CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX idx_campaign_quiz_backlog_next ON public.campaign_quiz_backlog (priority, created_at)
  WHERE status IN ('queued', 'building');

CREATE TRIGGER trg_campaign_quiz_backlog_set_updated_at
  BEFORE UPDATE ON public.campaign_quiz_backlog
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE public.campaign_quiz_agent_ops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backlog_id uuid REFERENCES public.campaign_quiz_backlog(id) ON DELETE SET NULL,
  quiz_slug text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('create', 'refresh', 'review')),
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
  request jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed', 'failed')),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_campaign_quiz_agent_ops_pending ON public.campaign_quiz_agent_ops (created_at) WHERE status = 'pending';
CREATE INDEX idx_campaign_quiz_agent_ops_slug ON public.campaign_quiz_agent_ops (quiz_slug, created_at DESC);

CREATE TRIGGER trg_campaign_quiz_agent_ops_set_updated_at
  BEFORE UPDATE ON public.campaign_quiz_agent_ops
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

ALTER TABLE public.campaign_quiz_backlog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_quiz_agent_ops ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.campaign_quiz_backlog FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.campaign_quiz_agent_ops FROM PUBLIC, anon, authenticated;

-- One backlog item per runner at a time: the next queued item, or a building one whose lease ran out (crash).
CREATE OR REPLACE FUNCTION public.claim_campaign_quiz_backlog(p_owner text, p_lease_seconds integer)
RETURNS SETOF public.campaign_quiz_backlog
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  UPDATE public.campaign_quiz_backlog item
  SET status = 'building',
      lease_owner = p_owner,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempts = CASE WHEN item.status = 'queued' THEN item.attempts + 1 ELSE item.attempts END
  WHERE item.id = (
    SELECT candidate.id FROM public.campaign_quiz_backlog candidate
    WHERE candidate.status = 'queued'
       OR (candidate.status = 'building' AND candidate.lease_expires_at < now())
    ORDER BY candidate.priority, candidate.created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  RETURNING item.*;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_campaign_quiz_backlog(text, integer) FROM PUBLIC, anon, authenticated;
