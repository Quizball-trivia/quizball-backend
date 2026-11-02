-- QuizBall HQ v3 fixes (20261103090000_hq_standup_goals is already applied).
--
-- One standup per agent per Tbilisi day, whichever path creates it: the 08:00
-- schedule (hq.fire_schedule), "Start standup now" (POST /standup/run) and a
-- manual schedule run (POST /schedules/:id/run-now) all use the same guard
-- under the same advisory lock, so they serialise and never duplicate.

-- True when the member already has today's standup: a (non-cancelled)
-- standup task created on that Tbilisi day, or a standup report for it.
CREATE FUNCTION hq.has_standup_today(p_member uuid, p_date date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = hq, pg_temp
AS $$
  SELECT EXISTS (
           SELECT 1 FROM hq.tasks x
            WHERE x.assignee_id = p_member AND x.kind = 'standup' AND x.status <> 'cancelled'
              AND x.created_at >= (p_date::timestamp AT TIME ZONE 'Asia/Tbilisi')
              AND x.created_at < ((p_date + 1)::timestamp AT TIME ZONE 'Asia/Tbilisi'))
      OR EXISTS (
           SELECT 1 FROM hq.standups st WHERE st.member_id = p_member AND st.standup_date = p_date);
$$;

-- Same contract as before. A standup schedule whose agent already has today's
-- standup still advances its slot but creates nothing (returns NULL and logs
-- a 'standup_skipped' event).
CREATE OR REPLACE FUNCTION hq.fire_schedule(
  p_schedule_id uuid,
  p_expected_next timestamptz,
  p_new_next timestamptz,
  p_title text
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  s hq.schedules;
  v_task uuid;
  v_today date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
BEGIN
  UPDATE hq.schedules
     SET next_run_at = p_new_next, last_run_at = now(), updated_at = now()
   WHERE id = p_schedule_id AND enabled AND next_run_at = p_expected_next
  RETURNING * INTO s;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF s.task_kind = 'standup' THEN
    -- Serialise with POST /standup/run and run-now (same lock key).
    PERFORM pg_advisory_xact_lock(hashtext('hq.standup_run'));
    IF hq.has_standup_today(s.member_id, v_today) THEN
      INSERT INTO hq.events (type, member_id, message, data)
      VALUES ('standup_skipped', s.member_id, 'Schedule "' || s.name || '" skipped: today''s standup already exists',
              jsonb_build_object('schedule_id', s.id, 'slot', p_expected_next, 'date', v_today));
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO hq.tasks (title, body, status, kind, assignee_id, schedule_id)
  VALUES (left(p_title, 200), s.task_body, 'todo', s.task_kind, s.member_id, s.id)
  RETURNING id INTO v_task;

  UPDATE hq.schedules SET last_task_id = v_task WHERE id = s.id;

  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES ('schedule_fired', s.member_id, v_task, 'Schedule "' || s.name || '" created a task',
          jsonb_build_object('schedule_id', s.id, 'slot', p_expected_next, 'kind', s.task_kind));
  RETURN v_task;
END;
$$;

REVOKE ALL ON FUNCTION hq.has_standup_today(uuid, date) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.has_standup_today(uuid, date) TO service_role';
  END IF;
END $$;
