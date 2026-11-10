-- The Executive Director can cancel open work when the founder says "drop it"
-- (or when it is obsolete). Same fences as its other decisions: its own live
-- run claim, the version it read, never an item waiting for the founder, never
-- work for an agent that changes things (code, posts, money).
CREATE FUNCTION hq.director_cancel_task(
  p_director uuid,
  p_run_task uuid,
  p_claim_token uuid,
  p_task uuid,
  p_expected_updated_at timestamptz,
  p_note text
)
RETURNS text
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  d hq.members;
  t hq.tasks;
  a hq.members;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  d := hq.director_check_run(p_director, p_run_task, p_claim_token);
  IF v_note IS NULL THEN
    RAISE EXCEPTION 'say why it is cancelled (the assignee and the founder read it)' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO t FROM hq.tasks WHERE id = p_task FOR UPDATE;
  IF t.id IS NULL OR t.kind NOT IN ('task', 'proposal')
     OR t.status NOT IN ('backlog', 'todo', 'in_progress', 'blocked', 'needs_approval', 'proposed') THEN
    RAISE EXCEPTION 'only open tasks and ideas can be cancelled (status %)', COALESCE(t.status, 'missing') USING ERRCODE = 'P0001';
  END IF;
  IF t.id = p_run_task THEN
    RAISE EXCEPTION 'you cannot cancel the task you are running' USING ERRCODE = 'P0001';
  END IF;
  IF t.escalated_at IS NOT NULL THEN
    RAISE EXCEPTION 'this is waiting for the founder; only the founder decides it now' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_updated_at IS NULL OR t.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'the task changed since you read it; read it again' USING ERRCODE = 'P0001';
  END IF;
  IF t.assignee_id IS NOT NULL THEN
    SELECT * INTO a FROM hq.members WHERE id = t.assignee_id;
    IF a.kind = 'human' THEN
      RAISE EXCEPTION 'that is %''s task; people decide their own work — escalate it', a.name USING ERRCODE = 'P0001';
    END IF;
    IF a.kind = 'agent' AND a.tier = 'act' THEN
      RAISE EXCEPTION '% changes things; only the founder cancels its work — escalate it', a.name USING ERRCODE = 'P0001';
    END IF;
    IF a.role = 'director' THEN
      RAISE EXCEPTION 'cancel your own work by finishing it with a note instead' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Clearing the claim fences a run working on it: the worker stops it at its
  -- next claim check (within 30 s), and whatever it finishes is recorded as
  -- "not applied" instead of changing the task. A cancelled idea counts as
  -- declined, so the founder's "Do it" still brings it back.
  UPDATE hq.tasks
     SET status = 'cancelled', completed_at = now(),
         claimed_by = NULL, claimed_at = NULL, claim_token = NULL,
         director_decision = CASE WHEN t.kind = 'proposal' THEN 'declined' ELSE director_decision END,
         director_note = v_note, decided_at = now(), updated_at = now()
   WHERE id = t.id;
  IF t.assignee_id IS NOT NULL AND t.assignee_id <> d.id THEN
    INSERT INTO hq.messages (task_id, author_id, recipient_id, kind, body)
    VALUES (t.id, d.id, t.assignee_id, 'comment', left('Cancelled: ' || v_note, 20000));
  END IF;
  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES ('director_cancelled', d.id, t.id,
          left(d.name || ' cancelled #' || t.number || ' ' || t.title || ' — ' || v_note, 500),
          jsonb_build_object('run_task_id', p_run_task, 'from', t.status));
  RETURN 'cancelled';
END;
$$;

REVOKE ALL ON FUNCTION hq.director_cancel_task(uuid, uuid, uuid, uuid, timestamptz, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.director_cancel_task(uuid, uuid, uuid, uuid, timestamptz, text) TO service_role';
  END IF;
END $$;
