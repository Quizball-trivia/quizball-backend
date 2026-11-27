-- Markets and ideas (HQ, straight to prod).
--   category_markets  which market a category is made for (Georgia, Turkey, Argentina, the UK, Spain). A category
--                     with no row is for everyone. This steers the work in HQ only: the game does not filter by
--                     country yet, so players everywhere still see every category.
--   content_events    an event may be made for one market.
--   ideas             one thing worth doing in the content: suggested by the Market Scout or written by a person.
--                     A person's idea is planned by the HQ Assistant first. Nothing is done until a person
--                     accepts it; a refusal (with its reason) is shown to the scout on its next round.

CREATE TABLE harness.category_markets (
  category_id  uuid PRIMARY KEY REFERENCES public.categories(id) ON DELETE CASCADE,
  market       text NOT NULL CHECK (market IN ('ge', 'tr', 'ar', 'uk', 'es')),
  updated_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE harness.category_markets ENABLE ROW LEVEL SECURITY;

ALTER TABLE harness.content_events
  ADD COLUMN market text NOT NULL DEFAULT 'all' CHECK (market IN ('all', 'ge', 'tr', 'ar', 'uk', 'es'));

-- Where the existing categories belong. Georgia and Turkey have none yet.
INSERT INTO harness.category_markets (category_id, market, updated_by)
SELECT c.id, m.market, 'setup'
  FROM (VALUES
    ('arsenal', 'uk'), ('aston-villa', 'uk'), ('bournemouth', 'uk'), ('brentford', 'uk'), ('chelsea', 'uk'), ('coventry-city', 'uk'),
    ('crystal-palace', 'uk'), ('england', 'uk'), ('england-world-cup', 'uk'), ('fulham', 'uk'), ('ipswich-town', 'uk'),
    ('leeds-united', 'uk'), ('liverpool', 'uk'), ('manchester-city', 'uk'), ('manchester-united', 'uk'), ('newcastle-united', 'uk'),
    ('nottingham-forest', 'uk'), ('premier-league', 'uk'), ('sunderland', 'uk'),
    ('barcelona', 'es'), ('real-madrid', 'es'), ('la-liga', 'es'), ('spain', 'es'), ('spain-world-cup', 'es'), ('world-cup-spain-1982', 'es'),
    ('argentina', 'ar'), ('argentina-1978', 'ar'), ('argentina-world-cup', 'ar'), ('maradona-world-cup', 'ar'), ('messi-world-cup', 'ar')
  ) AS m(slug, market)
  JOIN public.categories c ON c.slug = m.slug
ON CONFLICT (category_id) DO NOTHING;

CREATE SEQUENCE harness.idea_number;

CREATE TABLE harness.ideas (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         integer NOT NULL UNIQUE DEFAULT nextval('harness.idea_number'),
  source         text NOT NULL CHECK (source IN ('person', 'agent')),
  agent_slug     text REFERENCES harness.agents(slug),
  created_by     text,
  market         text NOT NULL DEFAULT 'all' CHECK (market IN ('all', 'ge', 'tr', 'ar', 'uk', 'es')),
  kind           text NOT NULL CHECK (kind IN ('category', 'event', 'questions', 'other')),
  title          text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  -- A person's own words, or the agent's reason with the numbers behind it.
  detail         text NOT NULL DEFAULT '' CHECK (length(detail) <= 2000),
  -- A page that backs a date or a fact in an agent's idea.
  source_url     text CHECK (source_url IS NULL OR length(source_url) <= 1000),
  -- planning: the HQ Assistant is working out a person's idea · open: waiting for a person ·
  -- accepted · refused · failed: the plan could not be made
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('planning', 'open', 'accepted', 'refused', 'failed')),
  -- How a person's idea would be done, in plain words.
  plan           text CHECK (plan IS NULL OR length(plan) <= 2000),
  -- What accepting does, each {type, ...}; validated again by the backend when applied.
  actions        jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(actions) = 'array'),
  applied        jsonb NOT NULL DEFAULT '[]'::jsonb,
  decided_by     text,
  refuse_reason  text CHECK (refuse_reason IS NULL OR length(refuse_reason) <= 500),
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE harness.ideas ENABLE ROW LEVEL SECURITY;
CREATE INDEX harness_ideas_recent ON harness.ideas (status, created_at DESC);

-- Jobs can now plan one idea (idea_plan, for an idea) or look for new ones (idea_scout, which has no target).
ALTER TABLE harness.jobs ADD COLUMN idea_id uuid REFERENCES harness.ideas(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX harness_jobs_one_live_per_idea ON harness.jobs (idea_id) WHERE idea_id IS NOT NULL AND status IN ('queued', 'running');
-- One scouting round at a time: asking twice does not queue two.
CREATE UNIQUE INDEX harness_jobs_one_live_scout ON harness.jobs (kind) WHERE kind = 'idea_scout' AND status IN ('queued', 'running');
ALTER TABLE harness.jobs DROP CONSTRAINT IF EXISTS harness_jobs_kind;
ALTER TABLE harness.jobs DROP CONSTRAINT IF EXISTS harness_jobs_target;
ALTER TABLE harness.jobs
  ADD CONSTRAINT harness_jobs_kind CHECK (kind IN ('plan', 'make', 'fact_check', 'quality_judge', 'localize', 'locale_check', 'ask', 'show_check', 'game_plan', 'report', 'idea_plan', 'idea_scout')),
  ADD CONSTRAINT harness_jobs_target CHECK (item_id IS NOT NULL OR brief_id IS NOT NULL OR ask_id IS NOT NULL OR show_pack_id IS NOT NULL OR game_change_id IS NOT NULL OR report_id IS NOT NULL OR idea_id IS NOT NULL OR kind = 'idea_scout');

-- Saves the plan for a person's idea, but only from the job that still holds its lease on an idea still being
-- planned: a job cancelled under a running agent (the idea was withdrawn) writes nothing.
CREATE OR REPLACE FUNCTION harness.idea_planned(p_job uuid, p_token uuid, p_plan text, p_actions jsonb)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  j harness.jobs;
BEGIN
  SELECT * INTO j FROM harness.jobs WHERE id = p_job AND status = 'running' AND lease_token = p_token FOR UPDATE;
  IF NOT FOUND OR j.idea_id IS NULL THEN RETURN false; END IF;
  UPDATE harness.ideas
     SET status = 'open', plan = left(btrim(coalesce(p_plan, '')), 2000), error = NULL, updated_at = now(),
         actions = CASE WHEN jsonb_typeof(p_actions) = 'array' THEN p_actions ELSE '[]'::jsonb END
   WHERE id = j.idea_id AND status = 'planning';
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION harness.idea_planned(uuid, uuid, text, jsonb) FROM PUBLIC;

-- Saves the scout's ideas under its job's lease, once: a second save from the same job adds nothing.
-- p_ideas: [{market, kind, title, detail, source_url, actions}]. Returns how many were saved.
CREATE OR REPLACE FUNCTION harness.ideas_suggested(p_job uuid, p_token uuid, p_ideas jsonb)
RETURNS integer
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  j harness.jobs;
  n integer;
BEGIN
  SELECT * INTO j FROM harness.jobs WHERE id = p_job AND status = 'running' AND lease_token = p_token FOR UPDATE;
  IF NOT FOUND OR j.kind <> 'idea_scout' OR jsonb_typeof(p_ideas) <> 'array' THEN RETURN 0; END IF;
  IF j.result ? 'saved' THEN RETURN 0; END IF;
  INSERT INTO harness.ideas (source, agent_slug, market, kind, title, detail, source_url, actions)
  SELECT 'agent', j.agent_slug, x->>'market', x->>'kind', left(btrim(x->>'title'), 200), left(btrim(coalesce(x->>'detail', '')), 2000),
         nullif(x->>'source_url', ''), CASE WHEN jsonb_typeof(x->'actions') = 'array' THEN x->'actions' ELSE '[]'::jsonb END
    FROM jsonb_array_elements(p_ideas) AS x
   WHERE x->>'market' IN ('all', 'ge', 'tr', 'ar', 'uk', 'es')
     AND x->>'kind' IN ('category', 'event', 'questions', 'other')
     AND length(btrim(coalesce(x->>'title', ''))) >= 3
     AND length(coalesce(x->>'source_url', '')) <= 1000
   LIMIT 20;
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE harness.jobs SET result = coalesce(result, '{}'::jsonb) || jsonb_build_object('saved', n) WHERE id = j.id;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION harness.ideas_suggested(uuid, uuid, jsonb) FROM PUBLIC;

-- A job that gives up on an idea marks it failed, so nobody waits on a plan that will not come.
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
  ELSIF j.idea_id IS NOT NULL THEN
    UPDATE harness.ideas SET status = 'failed', error = left(coalesce(p_reason, 'failed'), 500), updated_at = now()
     WHERE id = j.idea_id AND status = 'planning';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION harness.job_gave_up(uuid, text) FROM PUBLIC;

-- The Market Scout: looks at what each market has, what is running short and what is coming up in football there,
-- and suggests what to make next. It never changes anything: a person accepts or refuses each idea.
INSERT INTO harness.agents (slug, name, team, description, provider, model, effort, primary_account, fallback_accounts, max_turns, timeout_ms)
VALUES ('market-scout', 'Market Scout', 'suggesting',
        'Looks at each market (Georgia, Turkey, Argentina, the UK, Spain) and at the game as a whole, and suggests what to make next: a new category, an event, a set of questions. A person accepts or refuses each idea.',
        'claude', 'claude-opus-5-5', NULL, 'claude-premium-5',
        ARRAY['claude-premium-4', 'claude-premium-3', 'claude-ultra', 'claude-premium-1', 'claude-premium-2'], 40, 540000)
ON CONFLICT (slug) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON harness.category_markets, harness.ideas TO service_role';
    EXECUTE 'GRANT USAGE ON SEQUENCE harness.idea_number TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.job_gave_up(uuid, text) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.idea_planned(uuid, uuid, text, jsonb) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.ideas_suggested(uuid, uuid, jsonb) TO service_role';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
