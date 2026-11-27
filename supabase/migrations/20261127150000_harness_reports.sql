-- Reports (HQ, straight to prod): the first agents outside Content and Games.
--   reports   one written piece of work by a desk agent for a department: the
--             Growth Analyst's weekly read of the numbers, the Investor Update
--             Writer's monthly draft, the Investor Scout's list of who to talk
--             to. The backend gathers the numbers and queues the job; the agent
--             writes; a person reads. Nothing here is ever sent to anyone
--             outside the company by an agent.

CREATE SEQUENCE harness.report_number;

CREATE TABLE harness.reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        integer NOT NULL UNIQUE DEFAULT nextval('harness.report_number'),
  agent_slug    text NOT NULL REFERENCES harness.agents(slug),
  department    text NOT NULL CHECK (department IN ('content', 'games', 'competitions', 'marketing', 'partners', 'investors')),
  title         text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  -- writing: the agent is working · ready: a person can read it · failed ·
  -- archived: a person put it away
  status        text NOT NULL DEFAULT 'writing' CHECK (status IN ('writing', 'ready', 'failed', 'archived')),
  -- {summary, sections: [{heading, points: []}], leads: [{name, kind, where, why, source, reach}], questions: []}
  body          jsonb,
  -- A person's name, or 'schedule' when it was due by itself.
  requested_by  text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE harness.reports ENABLE ROW LEVEL SECURITY;
CREATE INDEX harness_reports_recent ON harness.reports (department, created_at DESC);
-- An agent writes one report at a time: asking twice does not queue two.
CREATE UNIQUE INDEX harness_reports_one_writing ON harness.reports (agent_slug) WHERE status = 'writing';

-- Jobs can now write a report.
ALTER TABLE harness.jobs ADD COLUMN report_id uuid REFERENCES harness.reports(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX harness_jobs_one_live_per_report ON harness.jobs (report_id, kind)
  WHERE report_id IS NOT NULL AND status IN ('queued', 'running');
ALTER TABLE harness.jobs DROP CONSTRAINT IF EXISTS harness_jobs_kind;
ALTER TABLE harness.jobs DROP CONSTRAINT IF EXISTS harness_jobs_target;
ALTER TABLE harness.jobs
  ADD CONSTRAINT harness_jobs_kind CHECK (kind IN ('plan', 'make', 'fact_check', 'quality_judge', 'localize', 'locale_check', 'ask', 'show_check', 'game_plan', 'report')),
  ADD CONSTRAINT harness_jobs_target CHECK (item_id IS NOT NULL OR brief_id IS NOT NULL OR ask_id IS NOT NULL OR show_pack_id IS NOT NULL OR game_change_id IS NOT NULL OR report_id IS NOT NULL);

-- Saves a report, but only from the job that still holds its lease on a report still being written: a job
-- cancelled under a running agent can never write.
CREATE OR REPLACE FUNCTION harness.report_written(p_job uuid, p_token uuid, p_title text, p_body jsonb)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  j harness.jobs;
BEGIN
  SELECT * INTO j FROM harness.jobs WHERE id = p_job AND status = 'running' AND lease_token = p_token FOR UPDATE;
  IF NOT FOUND OR j.report_id IS NULL THEN RETURN false; END IF;
  UPDATE harness.reports
     SET status = 'ready', body = p_body, error = NULL, updated_at = now(),
         title = CASE WHEN length(btrim(coalesce(p_title, ''))) BETWEEN 3 AND 200 THEN btrim(p_title) ELSE title END
   WHERE id = j.report_id AND status = 'writing';
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION harness.report_written(uuid, uuid, text, jsonb) FROM PUBLIC;

-- A report job that gives up marks the report failed, so nobody waits on it.
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
  ELSIF j.show_pack_id IS NOT NULL THEN
    PERFORM harness.show_pack_checked(j.show_pack_id, (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'i', x.i::integer, 'source_id', j.input->'sources'->>((x.ord - 1)::integer), 'check', 'skipped',
               'note', 'The checker could not run: ' || left(coalesce(p_reason, 'failed'), 200))), '[]'::jsonb)
        FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(j.input->'indexes') = 'array' THEN j.input->'indexes' ELSE '[]'::jsonb END)
             WITH ORDINALITY AS x(i, ord)
       WHERE x.i ~ '^[0-9]{1,4}$'));
  ELSIF j.game_change_id IS NOT NULL THEN
    UPDATE harness.game_changes SET status = 'failed', error = left(coalesce(p_reason, 'failed'), 500), updated_at = now()
     WHERE id = j.game_change_id AND status = 'planning';
  ELSIF j.report_id IS NOT NULL THEN
    UPDATE harness.reports SET status = 'failed', error = left(coalesce(p_reason, 'failed'), 500), updated_at = now()
     WHERE id = j.report_id AND status = 'writing';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION harness.job_gave_up(uuid, text) FROM PUBLIC;

-- What every desk agent is told about the company. The owners keep it true (HQ, Agents page); an agent is told
-- never to fill a gap in it with a guess.
INSERT INTO harness.policies (key, value, note) VALUES
  ('company.profile', to_jsonb('QuizBall is a football trivia game on the web (quizball.io), with a mobile app in the works. Players answer football questions in head-to-head ranked matches, play a set of daily puzzle games, play party games with friends, and in Georgia join a live show every Monday night. The game runs in 9 languages. Focus markets: Georgia, Turkey, Argentina, Spain and the UK. The company is a team of five based in Tbilisi, Georgia. One partner, Freecroco, runs QuizBall games for its own players. Most content and day-to-day operations are run by AI agents, steered by the team.

Not written down yet (owners, please fill in): the stage of the company, money raised so far, how much we want to raise and what for, revenue, and how we plan to make money.'::text),
   'What the agents are told about the company. Kept true by the owners.')
ON CONFLICT (key) DO NOTHING;

-- The first desk agents. They read numbers the backend hands them (and, for the scout, the public web), and write.
INSERT INTO harness.agents (slug, name, team, description, provider, model, effort, primary_account, fallback_accounts, max_turns, timeout_ms)
VALUES
  ('growth-analyst', 'Growth Analyst', 'suggesting',
   'Reads the week''s numbers and writes what moved, the likely reason, and three things worth trying.',
   'claude', 'claude-opus-5-5', NULL, 'claude-premium-3',
   ARRAY['claude-premium-4', 'claude-ultra', 'claude-premium-1', 'claude-premium-5', 'claude-premium-2'], 8, 480000),
  ('investor-update-writer', 'Investor Update Writer', 'suggesting',
   'Drafts the monthly investor update from our real numbers: what grew, what did not, what we need. A person edits and sends it.',
   'claude', 'claude-opus-5-5', NULL, 'claude-premium-3',
   ARRAY['claude-premium-4', 'claude-ultra', 'claude-premium-1', 'claude-premium-5', 'claude-premium-2'], 8, 480000),
  ('investor-scout', 'Investor Scout', 'suggesting',
   'Finds funds and angels who back companies like ours at our stage, with the reason and a source for each. A person chooses who to approach.',
   'claude', 'claude-opus-5-5', NULL, 'claude-premium-4',
   ARRAY['claude-premium-3', 'claude-ultra', 'claude-premium-1', 'claude-premium-5', 'claude-premium-2'], 40, 540000)
ON CONFLICT (slug) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON harness.reports TO service_role';
    EXECUTE 'GRANT USAGE ON SEQUENCE harness.report_number TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.job_gave_up(uuid, text) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.report_written(uuid, uuid, text, jsonb) TO service_role';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
