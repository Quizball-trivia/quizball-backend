DELETE FROM harness.jobs WHERE kind IN ('round_plan', 'round_write', 'round_check', 'round_localize');
DROP INDEX IF EXISTS harness.harness_jobs_one_live_per_day_round;
DROP INDEX IF EXISTS harness.harness_jobs_one_live_round_plan;
ALTER TABLE harness.jobs DROP CONSTRAINT IF EXISTS harness_jobs_kind, DROP CONSTRAINT IF EXISTS harness_jobs_target, DROP COLUMN IF EXISTS day_round_id;
ALTER TABLE harness.jobs
  ADD CONSTRAINT harness_jobs_kind CHECK (kind IN ('plan', 'make', 'fact_check', 'quality_judge', 'localize', 'locale_check', 'ask', 'show_check', 'game_plan', 'report', 'idea_plan', 'idea_scout', 'feedback_read')),
  ADD CONSTRAINT harness_jobs_target CHECK (item_id IS NOT NULL OR brief_id IS NOT NULL OR ask_id IS NOT NULL OR show_pack_id IS NOT NULL OR game_change_id IS NOT NULL OR report_id IS NOT NULL OR idea_id IS NOT NULL OR feedback_read_id IS NOT NULL OR kind = 'idea_scout');
DROP FUNCTION IF EXISTS harness.rounds_planned(uuid, uuid, jsonb, text);
DROP FUNCTION IF EXISTS harness.round_step_done(uuid, uuid, jsonb, text, boolean, text);
DROP TABLE IF EXISTS harness.day_rounds;
DROP SEQUENCE IF EXISTS harness.day_round_number;
DELETE FROM harness.policies WHERE key IN ('days.pistas.ahead', 'days.pistas.max_open_rounds', 'days.pistas.store');
DELETE FROM harness.agents WHERE slug = 'day-builder' AND NOT EXISTS (SELECT 1 FROM harness.runs r WHERE r.agent_slug = harness.agents.slug);

-- job_gave_up as it was in 20261128100000_harness_feedback.sql
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
  ELSIF j.feedback_read_id IS NOT NULL THEN
    UPDATE harness.feedback_reads SET status = 'failed', error = left(coalesce(p_reason, 'failed'), 500), updated_at = now()
     WHERE id = j.feedback_read_id AND status = 'writing';
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
