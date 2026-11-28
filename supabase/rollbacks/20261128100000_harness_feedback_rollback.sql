-- Contact-form messages exist nowhere else (the email may never have gone out): they are kept in
-- harness.feedback_kept before the table is dropped, and the migration puts them back when it is applied again.
-- Season 3 ideas and game comments are copies of the game's own tables and are simply copied in again.
DO $$
BEGIN
  IF to_regclass('harness.feedback') IS NOT NULL THEN
    IF to_regclass('harness.feedback_kept') IS NULL THEN
      CREATE TABLE harness.feedback_kept AS SELECT * FROM harness.feedback WHERE source = 'form';
      ALTER TABLE harness.feedback_kept ENABLE ROW LEVEL SECURITY;
    ELSE
      INSERT INTO harness.feedback_kept SELECT f.* FROM harness.feedback f
       WHERE f.source = 'form' AND NOT EXISTS (SELECT 1 FROM harness.feedback_kept k WHERE k.source_ref = f.source_ref);
    END IF;
  END IF;
END $$;

DELETE FROM harness.jobs WHERE kind = 'feedback_read';
DROP INDEX IF EXISTS harness.harness_jobs_one_live_per_feedback_read;
ALTER TABLE harness.jobs DROP CONSTRAINT IF EXISTS harness_jobs_kind, DROP CONSTRAINT IF EXISTS harness_jobs_target, DROP COLUMN IF EXISTS feedback_read_id;
ALTER TABLE harness.jobs
  ADD CONSTRAINT harness_jobs_kind CHECK (kind IN ('plan', 'make', 'fact_check', 'quality_judge', 'localize', 'locale_check', 'ask', 'show_check', 'game_plan', 'report', 'idea_plan', 'idea_scout')),
  ADD CONSTRAINT harness_jobs_target CHECK (item_id IS NOT NULL OR brief_id IS NOT NULL OR ask_id IS NOT NULL OR show_pack_id IS NOT NULL OR game_change_id IS NOT NULL OR report_id IS NOT NULL OR idea_id IS NOT NULL OR kind = 'idea_scout');
DROP FUNCTION IF EXISTS harness.feedback_read_done(uuid, uuid, jsonb, jsonb);
DROP TABLE IF EXISTS harness.feedback_reads;
DROP SEQUENCE IF EXISTS harness.feedback_read_number;
DROP TABLE IF EXISTS harness.feedback;
DROP SEQUENCE IF EXISTS harness.feedback_number;
DROP FUNCTION IF EXISTS harness.feedback_language();
DROP FUNCTION IF EXISTS harness.is_georgian(text);
DELETE FROM harness.agents WHERE slug = 'feedback-reader' AND NOT EXISTS (SELECT 1 FROM harness.runs r WHERE r.agent_slug = harness.agents.slug);

-- job_gave_up as it was in 20261127190000_harness_markets_ideas.sql
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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.job_gave_up(uuid, text) TO service_role';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
