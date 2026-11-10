-- Idempotency ledger of the quiz-page agent: a retried commit returns the first result instead of writing twice; the
-- request hash refuses a key reused for a different request.
CREATE TABLE public.campaign_quiz_agent_commits (
  idempotency_key text PRIMARY KEY CHECK (char_length(idempotency_key) BETWEEN 16 AND 128),
  quiz_slug text NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'refresh', 'review')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_campaign_quiz_agent_commits_slug ON public.campaign_quiz_agent_commits (quiz_slug, created_at DESC);

ALTER TABLE public.campaign_quiz_agent_commits ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.campaign_quiz_agent_commits FROM PUBLIC, anon, authenticated;
