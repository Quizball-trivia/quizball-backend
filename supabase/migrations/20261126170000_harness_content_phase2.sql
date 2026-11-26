-- Content tab, phase 2 (HQ, straight to prod):
--   content_events      a dated event (El Clasico on Dec 14) over one or more
--                       categories; it becomes deadline briefs (source 'event').
--   category_proposals  a new category suggested by the team: created hidden,
--                       filled with a starter set (source 'seed'), then put live
--                       by a person.
--   asks                "Ask HQ": a person's message; the HQ Assistant agent
--                       answers with proposed actions that a person applies.

CREATE TABLE harness.content_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  happens_on    date NOT NULL,
  notes         text NOT NULL DEFAULT '' CHECK (length(notes) <= 1000),
  category_ids  uuid[] NOT NULL CHECK (cardinality(category_ids) BETWEEN 1 AND 6),
  per_category  integer NOT NULL CHECK (per_category BETWEEN 1 AND 20),
  difficulty    text NOT NULL DEFAULT 'mixed' CHECK (difficulty IN ('easy', 'medium', 'hard', 'mixed')),
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cancelled')),
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE harness.content_events ENABLE ROW LEVEL SECURITY;

CREATE TABLE harness.category_proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  why           text NOT NULL DEFAULT '' CHECK (length(why) <= 1000),
  category_id   uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  target        integer NOT NULL DEFAULT 30 CHECK (target BETWEEN 10 AND 100),
  status        text NOT NULL DEFAULT 'filling' CHECK (status IN ('filling', 'live', 'cancelled')),
  proposed_by   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE harness.category_proposals ENABLE ROW LEVEL SECURITY;

ALTER TABLE harness.briefs DROP CONSTRAINT IF EXISTS briefs_source_check;
ALTER TABLE harness.briefs
  ADD CONSTRAINT briefs_source_check CHECK (source IN ('health', 'request', 'event', 'seed')),
  ADD COLUMN event_id    uuid REFERENCES harness.content_events(id) ON DELETE SET NULL,
  ADD COLUMN proposal_id uuid REFERENCES harness.category_proposals(id) ON DELETE SET NULL;
CREATE INDEX harness_briefs_event ON harness.briefs (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX harness_briefs_proposal ON harness.briefs (proposal_id) WHERE proposal_id IS NOT NULL;

CREATE TABLE harness.asks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message     text NOT NULL CHECK (length(message) BETWEEN 2 AND 2000),
  asked_by    text,
  status      text NOT NULL DEFAULT 'thinking' CHECK (status IN ('thinking', 'answered', 'failed', 'applied', 'dismissed')),
  reply       text,
  -- Proposed actions, each {type, ...}; validated again by the backend when applied.
  actions     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(actions) = 'array'),
  applied     jsonb NOT NULL DEFAULT '[]'::jsonb,
  error       text,
  applied_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE harness.asks ENABLE ROW LEVEL SECURITY;
CREATE INDEX harness_asks_recent ON harness.asks (created_at DESC);

-- Jobs can now answer an ask.
ALTER TABLE harness.jobs ADD COLUMN ask_id uuid REFERENCES harness.asks(id) ON DELETE CASCADE;
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname, pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid = 'harness.jobs'::regclass AND contype = 'c' LOOP
    IF c.d LIKE '%kind = ANY%' OR c.d LIKE '%item_id IS NOT NULL%brief_id IS NOT NULL%' THEN
      EXECUTE format('ALTER TABLE harness.jobs DROP CONSTRAINT %I', c.conname);
    END IF;
  END LOOP;
END $$;
ALTER TABLE harness.jobs
  ADD CONSTRAINT harness_jobs_kind CHECK (kind IN ('plan', 'make', 'fact_check', 'quality_judge', 'localize', 'locale_check', 'ask')),
  ADD CONSTRAINT harness_jobs_target CHECK (item_id IS NOT NULL OR brief_id IS NOT NULL OR ask_id IS NOT NULL);
CREATE UNIQUE INDEX harness_jobs_one_live_per_ask ON harness.jobs (ask_id) WHERE ask_id IS NOT NULL AND status IN ('queued', 'running');

-- A job that gives up on an ask marks the ask failed, so nobody waits on it forever.
CREATE OR REPLACE FUNCTION harness.job_gave_up(p_job uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  j harness.jobs;
BEGIN
  SELECT * INTO j FROM harness.jobs WHERE id = p_job;
  IF j.item_id IS NOT NULL THEN
    UPDATE harness.items
       SET stage = 'escalated', version = version + 1, updated_at = now(),
           last_issues = jsonb_build_array(jsonb_build_object('code', 'job-failed', 'path', j.kind, 'message', left(coalesce(p_reason, 'failed'), 500)))
     WHERE id = j.item_id AND version = j.item_version
       AND stage IN ('draft', 'validated', 'verified', 'localized', 'approved');
    IF FOUND THEN
      UPDATE harness.jobs SET status = 'cancelled', finished_at = now(), error = 'item escalated',
             lease_owner = NULL, lease_token = NULL, lease_until = NULL
       WHERE item_id = j.item_id AND status IN ('queued', 'running') AND id <> j.id;
      INSERT INTO harness.events (type, level, message, item_id, job_id)
      VALUES ('item_stage', 'warn', format('escalated: %s gave up', j.kind), j.item_id, j.id);
    END IF;
  ELSIF j.brief_id IS NOT NULL THEN
    UPDATE harness.briefs SET status = 'cancelled', updated_at = now() WHERE id = j.brief_id AND status = 'open';
  ELSIF j.ask_id IS NOT NULL THEN
    UPDATE harness.asks SET status = 'failed', error = left(coalesce(p_reason, 'failed'), 500), updated_at = now()
     WHERE id = j.ask_id AND status = 'thinking';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION harness.job_gave_up(uuid, text) FROM PUBLIC;

-- The HQ Assistant: reads the team's message and the content state, proposes
-- actions from the Content tab's own controls. It never applies anything.
INSERT INTO harness.agents (slug, name, team, description, provider, model, effort, primary_account, fallback_accounts, max_turns, timeout_ms)
VALUES ('hq-assistant', 'HQ Assistant', 'suggesting',
        'Turns a message from the team ("focus on Spanish clubs this week") into proposed Content tab actions. A person applies them.',
        'claude', 'claude-sonnet-5-5', NULL, 'claude-premium-3', ARRAY['claude-premium-4', 'claude-premium-5'], 4, 180000)
ON CONFLICT (slug) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON harness.content_events, harness.category_proposals, harness.asks TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.job_gave_up(uuid, text) TO service_role';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
