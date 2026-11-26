-- Games hub, step 2 (HQ, straight to prod): changes to a game.
--   game_changes   one requested change to one game. A person writes what they
--                  want (or, later, an agent suggests it); the Game Planner
--                  agent turns it into a plan a person can read; then it is
--                  built, played and approved. This migration covers asking
--                  and planning; building is connected in a later one.

CREATE SEQUENCE harness.game_change_number;

CREATE TABLE harness.game_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- A short number people can say out loud ("change 12").
  number        integer NOT NULL UNIQUE DEFAULT nextval('harness.game_change_number'),
  -- The game's key in the Games hub list (backend harness.games.ts).
  game_key      text NOT NULL CHECK (game_key ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  title         text NOT NULL CHECK (length(title) BETWEEN 3 AND 140),
  request       text NOT NULL CHECK (length(request) BETWEEN 10 AND 6000),
  source        text NOT NULL DEFAULT 'person' CHECK (source IN ('person', 'agent')),
  requested_by  text,
  -- suggested: an agent's idea waiting for a person · planning: the planner is
  -- working · planned: a plan is ready to read · building / ready: being built,
  -- then playable (later migration) · merged, declined, cancelled, failed: over
  status        text NOT NULL DEFAULT 'planning'
                CHECK (status IN ('suggested', 'planning', 'planned', 'building', 'ready', 'merged', 'declined', 'cancelled', 'failed')),
  -- {summary, size, changes: [{area, what}], risks: [], test: [], questions: []}
  plan          jsonb,
  error         text,
  decided_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE harness.game_changes ENABLE ROW LEVEL SECURITY;
CREATE INDEX harness_game_changes_recent ON harness.game_changes (created_at DESC);
CREATE INDEX harness_game_changes_game ON harness.game_changes (game_key, created_at DESC);

-- Jobs can now plan a game change.
ALTER TABLE harness.jobs ADD COLUMN game_change_id uuid REFERENCES harness.game_changes(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX harness_jobs_one_live_per_game_change ON harness.jobs (game_change_id, kind)
  WHERE game_change_id IS NOT NULL AND status IN ('queued', 'running');
ALTER TABLE harness.jobs DROP CONSTRAINT IF EXISTS harness_jobs_kind;
ALTER TABLE harness.jobs DROP CONSTRAINT IF EXISTS harness_jobs_target;
ALTER TABLE harness.jobs
  ADD CONSTRAINT harness_jobs_kind CHECK (kind IN ('plan', 'make', 'fact_check', 'quality_judge', 'localize', 'locale_check', 'ask', 'show_check', 'game_plan')),
  ADD CONSTRAINT harness_jobs_target CHECK (item_id IS NOT NULL OR brief_id IS NOT NULL OR ask_id IS NOT NULL OR show_pack_id IS NOT NULL OR game_change_id IS NOT NULL);

-- A planning job that gives up marks the change failed, so nobody waits on it.
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
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION harness.job_gave_up(uuid, text) FROM PUBLIC;

-- The Game Planner: reads the request and the game's real code (the
-- repositories are public), and writes a plan a person can judge before
-- anything is built. It never changes code.
INSERT INTO harness.agents (slug, name, team, description, provider, model, effort, primary_account, fallback_accounts, max_turns, timeout_ms)
VALUES ('game-planner', 'Game Planner', 'suggesting',
        'Turns a requested change to a game into a short plan: what changes, where, what could go wrong and how to test it. A person reads it before anything is built.',
        'claude', 'claude-opus-5-5', NULL, 'claude-ultra',
        ARRAY['claude-premium-4', 'claude-premium-1', 'claude-premium-5', 'claude-premium-2', 'claude-premium-3'], 30, 540000)
ON CONFLICT (slug) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON harness.game_changes TO service_role';
    EXECUTE 'GRANT USAGE ON SEQUENCE harness.game_change_number TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.job_gave_up(uuid, text) TO service_role';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
