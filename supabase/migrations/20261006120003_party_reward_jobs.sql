-- Durable Party Quiz reward work. A row is written when a Party match completes; it is `done` only once achievements,
-- objectives and XP all succeeded. Failures retry with backoff (next_attempt_at); a lease (claimed_until) keeps two
-- workers or replicas off the same match, and claim_token fences every later write to the worker that holds it, so a
-- worker whose lease ran out cannot touch its replacement's job. The reconciler backfills completed matches with no row.
CREATE TABLE IF NOT EXISTS public.party_reward_jobs (
  match_id uuid PRIMARY KEY REFERENCES public.matches(id) ON DELETE CASCADE,
  user_ids uuid[] NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  claim_token uuid,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_party_reward_jobs_due ON public.party_reward_jobs (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_party_reward_jobs_done ON public.party_reward_jobs (updated_at) WHERE status = 'done';

ALTER TABLE public.party_reward_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.party_reward_jobs FROM PUBLIC, anon, authenticated;
