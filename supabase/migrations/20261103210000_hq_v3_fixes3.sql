-- QuizBall HQ v3 fixes, round 3 (everything through 20261103200000 is applied).
--
--   1. hq.prepare_standup serialises with the worker's hq.claim_next_task, so
--      a stale standup can't be claimed while it is being superseded.
--   2. The activity rollup always recomputes yesterday as well as today, so
--      plays that commit just after midnight with yesterday's timestamp land.
--   3. hq.active_identities_between returns NULL (unknown) when the window
--      starts before the rollup's covered range, instead of a partial count.

-- ── 1. standup guard vs claims ────────────────────────────────────────────
-- Lock order (no cycles): callers hold 'hq.standup_run'; this function then
-- takes 'hq.claim_next_task' (the lock hq.claim_next_task takes first).
-- hq.claim_next_task never takes 'hq.standup_run', and human edits take only
-- row locks. With the claim lock held no standup can become in_progress until
-- this transaction commits; the post-supersede re-check makes that explicit.
CREATE OR REPLACE FUNCTION hq.prepare_standup(p_member uuid, p_date date)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('hq.claim_next_task'));

  IF hq.has_standup_today(p_member, p_date) THEN
    RETURN false;
  END IF;

  WITH superseded AS (
    UPDATE hq.tasks t
       SET status = 'cancelled', completed_at = now(),
           claimed_by = NULL, claimed_at = NULL, claim_token = NULL, updated_at = now()
     WHERE t.assignee_id = p_member AND t.kind = 'standup'
       AND t.status IN ('todo', 'backlog', 'blocked')
       AND t.created_at < (p_date::timestamp AT TIME ZONE 'Asia/Tbilisi')
    RETURNING t.id
  ), msg AS (
    INSERT INTO hq.messages (task_id, kind, body)
    SELECT id, 'system', 'Superseded by today''s standup' FROM superseded
    RETURNING task_id
  )
  INSERT INTO hq.events (type, member_id, task_id, message, data)
  SELECT 'standup_superseded', p_member, task_id, 'An unfinished standup was superseded by today''s',
         jsonb_build_object('date', p_date)
    FROM msg;

  IF EXISTS (SELECT 1 FROM hq.tasks x
              WHERE x.assignee_id = p_member AND x.kind = 'standup' AND x.status = 'in_progress') THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

-- ── 2. rollup reconciliation overlap ──────────────────────────────────────
-- Same contract as 20261103180000. Every refresh recomputes from
-- min(first unfinalised day, yesterday) through today: yesterday is
-- re-reconciled on each refresh (≤ once a minute), so late commits carrying
-- yesterday's timestamp are picked up. complete_through still records the
-- last day that has been refreshed after it ended.
CREATE OR REPLACE FUNCTION hq.ensure_activity_days(p_from date)
RETURNS void
LANGUAGE plpgsql
SET search_path = hq, public, pg_temp
AS $$
DECLARE
  st hq.activity_rollup_state;
  v_today date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
  v_from date := GREATEST(p_from, v_today - 400);   -- never backfill more than ~13 months on demand
BEGIN
  IF current_setting('transaction_read_only') = 'on' THEN
    RETURN;
  END IF;
  SELECT * INTO st FROM hq.activity_rollup_state WHERE id;
  IF st.computed_from IS NOT NULL AND v_from >= st.computed_from
     AND st.complete_through >= v_today - 1 AND st.refreshed_at > now() - interval '60 seconds' THEN
    RETURN;   -- fresh enough: the common path takes no lock and writes nothing
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('hq.activity_days')) THEN
    RETURN;
  END IF;
  SELECT * INTO st FROM hq.activity_rollup_state WHERE id FOR UPDATE;

  IF st.computed_from IS NULL THEN
    PERFORM hq.refresh_activity_days(v_from, v_today);
    st.computed_from := v_from;
  ELSE
    IF v_from < st.computed_from THEN
      PERFORM hq.refresh_activity_days(v_from, st.computed_from - 1);
      st.computed_from := v_from;
    END IF;
    PERFORM hq.refresh_activity_days(
      GREATEST(LEAST(COALESCE(st.complete_through + 1, v_today - 1), v_today - 1), st.computed_from),
      v_today);
  END IF;

  UPDATE hq.activity_rollup_state
     SET computed_from = st.computed_from, complete_through = v_today - 1, refreshed_at = now()
   WHERE id;
END;
$$;

-- ── 3. unknown instead of partial ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION hq.active_identities_between(p_from date, p_to date)
RETURNS integer
LANGUAGE plpgsql
SET search_path = hq, public, pg_temp
AS $$
DECLARE
  v_covered_from date;
BEGIN
  PERFORM hq.ensure_activity_days(p_from);
  SELECT computed_from INTO v_covered_from FROM hq.activity_rollup_state WHERE id;
  -- Window starts before what the rollup covers (older than the on-demand
  -- backfill limit, or not backfilled yet): the count would be partial.
  IF v_covered_from IS NULL OR p_from < v_covered_from THEN
    RETURN NULL;
  END IF;
  RETURN (
    SELECT count(DISTINCT ad.ident)
      FROM hq.activity_days ad
      LEFT JOIN public.users u
        ON u.id = ad.user_id AND NOT u.is_ai AND NOT u.is_seed AND NOT u.is_guest AND NOT u.is_deleted
     WHERE ad.day BETWEEN p_from AND p_to
       AND (ad.user_id IS NULL OR u.id IS NOT NULL)
  );
END;
$$;
