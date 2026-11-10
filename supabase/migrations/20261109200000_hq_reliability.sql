-- QuizBall HQ reliability (worker outages, schedule pile-ups, stuck tasks).
--
-- Every function keeps its existing signature: the deployed hq-worker is
-- updated separately (rsync to the VPS), so old and new workers must both work
-- against this schema.
--
--   1. hq.provider_status — durable outage state per model provider. An auth
--      failure (revoked key, logged out) backs off 15 min → 30 → 60 → 120 →
--      360 max; a usage/rate limit waits 15 min. The state survives restarts
--      and is shared by every worker. Nov 5–9 2026: a revoked key produced
--      ~190 failed runs a day because the cooldown lived in memory and never
--      grew.
--   2. hq.fire_schedule coalesces: while an earlier task of the same schedule
--      is still queued (backlog / todo / in_progress), a due slot advances
--      without a new task. Tasks waiting on a person (blocked, needs_approval)
--      do not suppress new runs.
--   3. hq.claim_next_task never starts a standup from an earlier Tbilisi day;
--      such standups are cancelled under the claim lock first.
--   4. hq.finish_task is idempotent: a retry after a lost acknowledgement gets
--      true again instead of looking like a human change.
--   5. hq.reconcile_stalled — re-queues HQ tasks left in_progress with no live
--      run (a finish that never landed, a worker that died on another host).

-- ── 1. provider status ─────────────────────────────────────────────────────
CREATE TABLE hq.provider_status (
  provider    text PRIMARY KEY CHECK (provider ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  state       text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'auth', 'limit')),
  failures    integer NOT NULL DEFAULT 0 CHECK (failures >= 0),
  since       timestamptz,
  until       timestamptz,
  last_error  text,
  -- Latest subscription usage per limit window ('five_hour', 'seven_day', …):
  -- {"<window>": {"status", "utilization" (0-1), "resets_at", "seen_at"}}.
  windows     jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hq.provider_status ENABLE ROW LEVEL SECURITY;

-- How much of the owner's Claude plan HQ may use. At plan_soft_pct of any
-- window only urgent work runs; at plan_hard_pct nothing runs until it resets.
ALTER TABLE hq.settings
  ADD COLUMN plan_soft_pct integer NOT NULL DEFAULT 60 CHECK (plan_soft_pct BETWEEN 1 AND 100),
  ADD COLUMN plan_hard_pct integer NOT NULL DEFAULT 85 CHECK (plan_hard_pct BETWEEN 1 AND 100),
  ADD CONSTRAINT hq_settings_plan_pct_order CHECK (plan_soft_pct <= plan_hard_pct);

-- Records a failed call. Returns the resulting row plus whether this call
-- opened the incident (so exactly one alert goes out per outage). While an
-- outage window is still open, further failures don't extend it: the first
-- failure after it ends (the recovery probe) escalates instead.
-- p_until: when the plan reported its reset time (a limit hit), wait exactly
-- until then (clamped to 1 min .. 8 days) instead of the 15-minute guess.
CREATE FUNCTION hq.provider_trip(p_provider text, p_kind text, p_error text, p_until timestamptz DEFAULT NULL)
RETURNS TABLE (state text, failures integer, until timestamptz, opened boolean)
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  r hq.provider_status;
  v_was_ok boolean;
  v_wait interval;
BEGIN
  IF p_kind NOT IN ('auth', 'limit') THEN
    RAISE EXCEPTION 'provider_trip: kind must be auth or limit (got %)', p_kind;
  END IF;
  INSERT INTO hq.provider_status (provider) VALUES (p_provider) ON CONFLICT (provider) DO NOTHING;
  SELECT * INTO r FROM hq.provider_status ps WHERE ps.provider = p_provider FOR UPDATE;

  IF r.state <> 'ok' AND r.until > now() THEN
    RETURN QUERY SELECT r.state, r.failures, r.until, false;
    RETURN;
  END IF;

  v_was_ok := r.state = 'ok';
  r.failures := CASE WHEN v_was_ok THEN 1 ELSE r.failures + 1 END;
  v_wait := CASE
    WHEN p_kind = 'limit' AND p_until IS NOT NULL
      THEN LEAST(GREATEST(p_until - now(), interval '1 minute'), interval '8 days')
    WHEN p_kind = 'limit' THEN interval '15 minutes'
    ELSE LEAST(interval '15 minutes' * power(2, LEAST(r.failures - 1, 10)), interval '6 hours')
  END;

  UPDATE hq.provider_status ps
     SET state = p_kind,
         failures = r.failures,
         since = CASE WHEN v_was_ok THEN now() ELSE ps.since END,
         until = now() + v_wait,
         last_error = left(p_error, 500),
         updated_at = now()
   WHERE ps.provider = p_provider
  RETURNING * INTO r;

  RETURN QUERY SELECT r.state, r.failures, r.until, v_was_ok;
END;
$$;

-- Records a successful call. Returns true when this closed an incident.
CREATE FUNCTION hq.provider_clear(p_provider text)
RETURNS boolean
LANGUAGE sql
SET search_path = hq, pg_temp
AS $$
  WITH prev AS (
    SELECT state FROM hq.provider_status WHERE provider = p_provider FOR UPDATE
  ), u AS (
    UPDATE hq.provider_status
       SET state = 'ok', failures = 0, since = NULL, until = NULL, updated_at = now()
     WHERE provider = p_provider AND state <> 'ok'
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u);
$$;

-- Merges the latest per-window plan usage reported by a run (top-level keys
-- replace older readings of the same window). Returns the merged windows.
CREATE FUNCTION hq.provider_record_windows(p_provider text, p_windows jsonb)
RETURNS jsonb
LANGUAGE sql
SET search_path = hq, pg_temp
AS $$
  INSERT INTO hq.provider_status AS ps (provider, windows)
  VALUES (p_provider, COALESCE(p_windows, '{}'::jsonb))
  ON CONFLICT (provider) DO UPDATE
     SET windows = ps.windows || COALESCE(EXCLUDED.windows, '{}'::jsonb), updated_at = now()
  RETURNING ps.windows;
$$;

-- ── 2. schedule coalescing ─────────────────────────────────────────────────
CREATE INDEX hq_tasks_schedule_queued_idx ON hq.tasks (schedule_id)
  WHERE status IN ('backlog', 'todo', 'in_progress');

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
  v_kind text;
  v_task uuid;
  v_queued bigint;
  v_today date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
BEGIN
  SELECT task_kind INTO v_kind FROM hq.schedules WHERE id = p_schedule_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_kind = 'standup' THEN
    PERFORM pg_advisory_xact_lock(hashtext('hq.standup_run'));
  END IF;

  -- The row lock taken here also serialises with a manual "run now"
  -- (SELECT … FOR UPDATE on the schedule in the backend).
  UPDATE hq.schedules
     SET next_run_at = p_new_next, last_run_at = now(), updated_at = now()
   WHERE id = p_schedule_id AND enabled AND next_run_at = p_expected_next
  RETURNING * INTO s;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF s.task_kind = 'standup' THEN
    IF v_kind IS DISTINCT FROM 'standup' THEN
      PERFORM pg_advisory_xact_lock(hashtext('hq.standup_run'));
    END IF;
    IF NOT hq.prepare_standup(s.member_id, v_today) THEN
      INSERT INTO hq.events (type, member_id, message, data)
      VALUES ('standup_skipped', s.member_id, 'Schedule "' || s.name || '" skipped: today''s standup already exists',
              jsonb_build_object('schedule_id', s.id, 'slot', p_expected_next, 'date', v_today));
      RETURN NULL;
    END IF;
  ELSE
    SELECT min(t.number) INTO v_queued
      FROM hq.tasks t
     WHERE t.schedule_id = s.id AND t.status IN ('backlog', 'todo', 'in_progress');
    IF v_queued IS NOT NULL THEN
      INSERT INTO hq.events (type, member_id, message, data)
      VALUES ('schedule_coalesced', s.member_id,
              'Schedule "' || s.name || '" skipped a run: #' || v_queued || ' from an earlier run is still queued',
              jsonb_build_object('schedule_id', s.id, 'slot', p_expected_next, 'queued_task_number', v_queued));
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

-- ── 3. claims never start an earlier day's standup ────────────────────────
-- Lock order is unchanged: this takes only 'hq.claim_next_task' (callers that
-- also hold 'hq.standup_run' take it first, in prepare_standup).
-- p_urgent_only: near the plan limit, only priority-0 work is claimed. The
-- deployed worker calls claim_next_task(p_worker => …) and gets the default.
DROP FUNCTION hq.claim_next_task(text);
CREATE FUNCTION hq.claim_next_task(p_worker text, p_urgent_only boolean DEFAULT false)
RETURNS SETOF hq.tasks
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  v_day_start timestamptz := ((now() AT TIME ZONE 'Asia/Tbilisi')::date)::timestamp AT TIME ZONE 'Asia/Tbilisi';
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('hq.claim_next_task'));

  -- SKIP LOCKED: a row someone is editing right now must not stall every
  -- claim; it is expired on a later poll (and is never claimable meanwhile).
  WITH candidates AS (
    SELECT c.id
      FROM hq.tasks c
     WHERE c.kind = 'standup'
       AND c.status IN ('todo', 'backlog', 'blocked')
       AND c.created_at < v_day_start
     FOR UPDATE SKIP LOCKED
  ), expired AS (
    UPDATE hq.tasks t
       SET status = 'cancelled', completed_at = now(),
           claimed_by = NULL, claimed_at = NULL, claim_token = NULL, updated_at = now()
      FROM candidates c
     WHERE t.id = c.id
    RETURNING t.id, t.assignee_id
  ), msg AS (
    INSERT INTO hq.messages (task_id, kind, body)
    SELECT id, 'system', 'Expired: a standup only counts on the day it was scheduled' FROM expired
    RETURNING task_id
  )
  INSERT INTO hq.events (type, member_id, task_id, message)
  SELECT 'standup_expired', e.assignee_id, e.id, 'A standup from an earlier day expired without running'
    FROM expired e;

  RETURN QUERY
  UPDATE hq.tasks t
     SET status = 'in_progress',
         claimed_by = p_worker,
         claimed_at = now(),
         claim_token = gen_random_uuid(),
         attempts = t.attempts + 1,
         updated_at = now()
   WHERE t.id = (
     SELECT c.id
       FROM hq.tasks c
       JOIN hq.members m ON m.id = c.assignee_id
      WHERE c.status = 'todo'
        AND m.kind = 'agent'
        AND m.runtime = 'hq'
        AND m.status = 'active'
        AND (c.kind <> 'standup' OR c.created_at >= v_day_start)
        AND (NOT p_urgent_only OR c.priority = 0)
        AND NOT EXISTS (
          SELECT 1 FROM hq.tasks busy
           WHERE busy.assignee_id = c.assignee_id AND busy.status = 'in_progress'
        )
        AND NOT EXISTS (
          SELECT 1 FROM hq.runs r
           WHERE r.status = 'running'
             AND r.started_at > now() - interval '15 minutes'
             AND (r.member_id = c.assignee_id OR r.task_id = c.id)
        )
      ORDER BY c.priority, c.created_at
      FOR UPDATE OF c SKIP LOCKED
      LIMIT 1
   )
  RETURNING t.*;
END;
$$;

-- ── 4. idempotent finish ──────────────────────────────────────────────────
ALTER TABLE hq.tasks ADD COLUMN finished_claim_token uuid;

CREATE OR REPLACE FUNCTION hq.finish_task(
  p_task_id uuid,
  p_claim_token uuid,
  p_status text,
  p_result text,
  p_refund_attempt boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
BEGIN
  IF p_status NOT IN ('todo', 'needs_approval', 'blocked', 'done') THEN
    RETURN false;
  END IF;

  UPDATE hq.tasks
     SET status = p_status,
         result = COALESCE(p_result, result),
         completed_at = CASE WHEN p_status = 'done' THEN now() ELSE NULL END,
         attempts = CASE WHEN p_refund_attempt THEN GREATEST(attempts - 1, 0) ELSE attempts END,
         claimed_by = NULL,
         claimed_at = NULL,
         claim_token = NULL,
         finished_claim_token = p_claim_token,
         updated_at = now()
   WHERE id = p_task_id
     AND status = 'in_progress'
     AND claim_token = p_claim_token;
  IF FOUND THEN
    RETURN true;
  END IF;

  -- A retry of a finish that already landed (its acknowledgement was lost).
  -- Any later change by a person or a new claim moves the status or clears
  -- the token, so this only matches the untouched outcome of this claim.
  RETURN EXISTS (
    SELECT 1 FROM hq.tasks
     WHERE id = p_task_id
       AND finished_claim_token = p_claim_token
       AND status = p_status
       AND claim_token IS NULL
  );
END;
$$;

-- Human edits must also forget the finished token, or a stale worker retry
-- could report success for a task a person has since put back to the same
-- status. Any write that changes status or assignee without going through
-- finish_task clears it.
CREATE FUNCTION hq.tasks_forget_finished_token()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
BEGIN
  IF NEW.finished_claim_token IS NOT NULL
     AND NEW.finished_claim_token IS NOT DISTINCT FROM OLD.finished_claim_token
     AND (NEW.status IS DISTINCT FROM OLD.status
          OR NEW.assignee_id IS DISTINCT FROM OLD.assignee_id
          OR NEW.claim_token IS DISTINCT FROM OLD.claim_token) THEN
    NEW.finished_claim_token := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hq_tasks_forget_finished_token
  BEFORE UPDATE ON hq.tasks
  FOR EACH ROW EXECUTE FUNCTION hq.tasks_forget_finished_token();

-- ── 5. stalled task reconciliation ────────────────────────────────────────
-- A task is stalled when it is in_progress under a worker claim, the claim is
-- older than p_grace, and no run for it is still live. A run counts as live
-- while it is `running` and younger than p_grace (HQ runs are capped at 9 min
-- by the worker; p_grace defaults to 20). Dead `running` rows are closed too.
-- Only HQ-runtime agents are reconciled. Returns the re-queued task numbers.
CREATE FUNCTION hq.reconcile_stalled(p_grace interval DEFAULT interval '20 minutes')
RETURNS bigint[]
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  v_numbers bigint[];
BEGIN
  IF p_grace < interval '15 minutes' THEN
    RAISE EXCEPTION 'reconcile_stalled: grace must be at least 15 minutes';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hq.claim_next_task'));

  -- SKIP LOCKED throughout: this runs under the global claim lock, so waiting
  -- on one row someone else holds would stall every claim. A skipped row is
  -- reconciled on a later pass.
  WITH dead AS (
    SELECT r.id
      FROM hq.runs r
      JOIN hq.members m ON m.id = r.member_id
     WHERE m.runtime = 'hq'
       AND r.status = 'running'
       AND r.started_at < now() - p_grace
     FOR UPDATE OF r SKIP LOCKED
  )
  UPDATE hq.runs r
     SET status = 'failed', ended_at = now(), error = COALESCE(r.error, 'run lost (no worker finished it)')
    FROM dead
   WHERE r.id = dead.id;

  WITH candidates AS (
    SELECT t.id
      FROM hq.tasks t
      JOIN hq.members m ON m.id = t.assignee_id
     WHERE m.runtime = 'hq'
       AND t.status = 'in_progress'
       AND t.claim_token IS NOT NULL
       AND t.claimed_at < now() - p_grace
       AND NOT EXISTS (
         SELECT 1 FROM hq.runs r WHERE r.task_id = t.id AND r.status = 'running'
       )
     FOR UPDATE OF t SKIP LOCKED
  ), stalled AS (
    UPDATE hq.tasks t
       SET status = 'todo',
           claimed_by = NULL, claimed_at = NULL, claim_token = NULL,
           attempts = GREATEST(t.attempts - 1, 0),
           updated_at = now()
      FROM candidates c
     WHERE t.id = c.id
    RETURNING t.id, t.number, t.assignee_id
  ), msg AS (
    INSERT INTO hq.messages (task_id, kind, body)
    SELECT id, 'system', 'Re-queued: the run working on this task stopped without saving an outcome.' FROM stalled
    RETURNING task_id
  ), ev AS (
    INSERT INTO hq.events (type, level, member_id, task_id, message)
    SELECT 'task_reconciled', 'warn', s.assignee_id, s.id,
           '#' || s.number || ' was stuck in progress with no live run; re-queued'
      FROM stalled s
    RETURNING 1
  )
  SELECT array_agg(number ORDER BY number) INTO v_numbers FROM stalled;

  RETURN COALESCE(v_numbers, ARRAY[]::bigint[]);
END;
$$;

REVOKE ALL ON FUNCTION hq.provider_trip(text, text, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.provider_record_windows(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.claim_next_task(text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.provider_clear(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.reconcile_stalled(interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.tasks_forget_finished_token() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON hq.provider_status TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.provider_trip(text, text, text, timestamptz) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.provider_record_windows(text, jsonb) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.claim_next_task(text, boolean) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.provider_clear(text) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.reconcile_stalled(interval) TO service_role';
  END IF;
END;
$$;
