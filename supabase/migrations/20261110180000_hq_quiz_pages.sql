-- HQ: the quiz-page agent joins the team under the Executive Director.
--
-- The agent (VPS runner, its own process) builds and refreshes the public quiz
-- pages through the backend's agent API. It becomes an HQ member with its own
-- runtime, 'quiz_pages':
--
--   * Every page it publishes or refreshes is a finished task the Director
--     checks. The backend's commit transaction writes it (hq.quiz_pages_report),
--     so a published page always has exactly one report and a crash can't lose
--     or double it. A newer version of the same page supersedes an unreviewed
--     older report.
--   * The Director reviews these reports; the only change to its functions is
--     that they accept runtime 'quiz_pages'. The agent publishes ('act'), so by
--     HQ's own rule the Director can't send its work back: it escalates, and the
--     founder sends a page back with a note. The runner reworks it and the same
--     task comes back for review. A report whose page changed since (a newer
--     version, a CMS save) is marked superseded by a trigger (next migration).
--   * Work assigned to it on the board is taken by hq.quiz_pages_intake. It is
--     an 'act' member (it publishes), so a task starts only after a person
--     approved it, or when it is one of its own reports sent back for rework.
--     Its own routine work (the build list and the two-weekly refresh) was
--     authorised by the founder and needs no task.
--   * A new page handed to the build list waits there without an HQ claim: the
--     list's own lease fences it, and the HQ claim index and reconcile_stalled
--     (HQ runtime only) are untouched. Rework holds an HQ claim kept alive by
--     hq.quiz_pages_heartbeat; intake recovers claims that went quiet.
--   * The build list's link to HQ (campaign_quiz_backlog.hq_task_id) is added
--     by the next migration; the functions below use it.
--   * Pausing the member in HQ stops publishing: the commit refuses while it is
--     not active. It writes no hq.runs (HQ's run budget is the Claude plan's).

-- ── 1. runtime, task reference, superseded reviews ───────────────────────
ALTER TABLE hq.members DROP CONSTRAINT members_runtime_check;
ALTER TABLE hq.members ADD CONSTRAINT members_runtime_check
  CHECK (runtime IN ('hq', 'question_agents', 'bug_triage', 'quiz_pages', 'none'));
CREATE UNIQUE INDEX hq_members_one_quiz_pages ON hq.members (runtime)
  WHERE runtime = 'quiz_pages' AND status <> 'archived';

-- What a pipeline task is about: {"quiz_page": slug, "version": n, "action": …, "op_key": …}.
ALTER TABLE hq.tasks ADD COLUMN ref jsonb CONSTRAINT hq_tasks_ref_object CHECK (ref IS NULL OR jsonb_typeof(ref) = 'object');
CREATE UNIQUE INDEX hq_tasks_ref_op_key ON hq.tasks ((ref ->> 'op_key')) WHERE ref ? 'op_key';
CREATE INDEX hq_tasks_ref_quiz_page ON hq.tasks ((ref ->> 'quiz_page')) WHERE ref ? 'quiz_page';

ALTER TABLE hq.tasks DROP CONSTRAINT hq_tasks_review_state;
ALTER TABLE hq.tasks ADD CONSTRAINT hq_tasks_review_state CHECK (review_state IN ('accepted', 'reopened', 'superseded'));

-- ── 2. the Director reviews its work ──────────────────────────────────────
CREATE OR REPLACE FUNCTION hq.director_unreviewed_work(p_limit integer DEFAULT 15)
RETURNS TABLE (id uuid, number bigint, title text, body text, result text, assignee_id uuid,
               completed_at timestamptz, reopen_count smallint, updated_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = hq, pg_temp
AS $$
  SELECT t.id, t.number, t.title, t.body, t.result, t.assignee_id, t.completed_at, t.reopen_count, t.updated_at
    FROM hq.tasks t
    JOIN hq.members m ON m.id = t.assignee_id
   WHERE t.status = 'done' AND t.review_state IS NULL AND t.escalated_at IS NULL
     AND t.kind IN ('task', 'proposal')
     AND m.kind = 'agent' AND m.runtime IN ('hq', 'quiz_pages') AND m.role = 'agent'
   ORDER BY t.completed_at NULLS FIRST, t.number
   LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

-- Accept finished work, send it back once more (max 2 times in total), or
-- send it to the founder. Returns the new review state.
CREATE OR REPLACE FUNCTION hq.director_review_work(
  p_director uuid,
  p_run_task uuid,
  p_claim_token uuid,
  p_task uuid,
  p_expected_updated_at timestamptz,
  p_verdict text,
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
  IF p_verdict NOT IN ('accept', 'reopen', 'escalate') THEN
    RAISE EXCEPTION 'verdict must be accept, reopen or escalate' USING ERRCODE = 'P0001';
  END IF;
  d := hq.director_check_run(p_director, p_run_task, p_claim_token);

  SELECT * INTO t FROM hq.tasks WHERE id = p_task FOR UPDATE;
  IF t.id IS NULL OR t.status <> 'done' OR t.kind NOT IN ('task', 'proposal') OR t.review_state IS NOT NULL THEN
    RAISE EXCEPTION 'this is not finished work waiting for review' USING ERRCODE = 'P0001';
  END IF;
  IF t.escalated_at IS NOT NULL THEN
    RAISE EXCEPTION 'already sent to the founder' USING ERRCODE = 'P0001';
  END IF;
  IF p_expected_updated_at IS NULL OR t.updated_at <> p_expected_updated_at THEN
    RAISE EXCEPTION 'the task changed since you read it; read it again before reviewing' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO a FROM hq.members WHERE id = t.assignee_id;
  IF a.id IS NULL OR a.runtime NOT IN ('hq', 'quiz_pages') OR a.role <> 'agent' THEN
    RAISE EXCEPTION 'you review HQ agents'' work, not your own or a person''s' USING ERRCODE = 'P0001';
  END IF;
  IF p_verdict <> 'accept' AND v_note IS NULL THEN
    RAISE EXCEPTION 'say exactly what is wrong or missing in the note' USING ERRCODE = 'P0001';
  END IF;

  IF p_verdict = 'accept' THEN
    UPDATE hq.tasks
       SET review_state = 'accepted', review_note = v_note, reviewed_at = now(), updated_at = now()
     WHERE id = t.id;
  ELSIF p_verdict = 'reopen' THEN
    IF t.reopen_count >= 2 THEN
      RAISE EXCEPTION 'this was already sent back twice; escalate it to the founder instead' USING ERRCODE = 'P0001';
    END IF;
    IF a.tier <> 'read' OR a.status <> 'active' THEN
      RAISE EXCEPTION 'only work by an active research agent can be re-run by you; escalate it' USING ERRCODE = 'P0001';
    END IF;
    UPDATE hq.tasks
       SET status = 'todo', completed_at = NULL, attempts = 0,
           claimed_by = NULL, claimed_at = NULL, claim_token = NULL,
           review_state = 'reopened', review_note = v_note, reviewed_at = now(),
           reopen_count = t.reopen_count + 1, updated_at = now()
     WHERE id = t.id;
    INSERT INTO hq.messages (task_id, author_id, recipient_id, kind, body)
    VALUES (t.id, d.id, t.assignee_id, 'comment', left('Sent back for rework: ' || v_note, 20000));
  ELSE
    UPDATE hq.tasks
       SET escalated_at = now(), director_decision = 'escalated', director_note = v_note,
           decided_at = now(), updated_at = now()
     WHERE id = t.id;
  END IF;

  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES (
    'director_' || CASE p_verdict WHEN 'accept' THEN 'accepted' WHEN 'reopen' THEN 'reopened' ELSE 'escalated' END,
    d.id, t.id,
    left(d.name || CASE p_verdict WHEN 'accept' THEN ' accepted #' WHEN 'reopen' THEN ' sent back #' ELSE ' sent to the founder #' END
         || t.number || ' ' || t.title || COALESCE(' — ' || v_note, ''), 500),
    jsonb_build_object('verdict', p_verdict, 'run_task_id', p_run_task)
  );
  RETURN CASE p_verdict WHEN 'accept' THEN 'accepted' WHEN 'reopen' THEN 'reopened' ELSE 'escalated' END;
END;
$$;

-- ── 3. the pipeline's side ────────────────────────────────────────────────
-- The agent's member row: the live one, else an archived one (archived = switched
-- off for good, never "no HQ here"). NULL only where HQ has no such member at all.
CREATE FUNCTION hq.quiz_pages_member()
RETURNS hq.members
LANGUAGE sql
STABLE
SET search_path = hq, pg_temp
AS $$
  SELECT * FROM hq.members WHERE runtime = 'quiz_pages'
   ORDER BY (status = 'archived'), updated_at DESC
   LIMIT 1;
$$;

-- Takes the next task the agent may start (or nothing), after recovering
-- work that went quiet. One at a time: the HQ index allows one claimed task
-- per agent.
CREATE FUNCTION hq.quiz_pages_intake(p_worker text, p_grace interval DEFAULT interval '20 minutes')
RETURNS SETOF hq.tasks
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  m hq.members := hq.quiz_pages_member();
  r record;
BEGIN
  IF m.id IS NULL OR m.status <> 'active' THEN
    RETURN;
  END IF;
  IF p_grace < interval '10 minutes' THEN
    RAISE EXCEPTION 'quiz_pages_intake: grace must be at least 10 minutes';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hq.quiz_pages_intake'));

  -- A rework whose runner stopped heart-beating: back to the queue, or blocked after 3 tries.
  FOR r IN
    SELECT t.id, t.attempts FROM hq.tasks t
     WHERE t.assignee_id = m.id AND t.status = 'in_progress' AND t.claim_token IS NOT NULL
       AND t.claimed_at < now() - p_grace
     FOR UPDATE SKIP LOCKED
  LOOP
    IF r.attempts >= 3 THEN
      UPDATE hq.tasks SET status = 'blocked', claimed_by = NULL, claimed_at = NULL, claim_token = NULL,
             result = COALESCE(result, 'Stopped after 3 tries without finishing.'), updated_at = now()
       WHERE id = r.id;
    ELSE
      UPDATE hq.tasks SET status = 'todo', claimed_by = NULL, claimed_at = NULL, claim_token = NULL, updated_at = now()
       WHERE id = r.id;
    END IF;
  END LOOP;

  -- A page queued for a task that the build list gave up on (held / skipped) or lost.
  FOR r IN
    SELECT t.id, t.title, b.status AS item_status, b.last_error
      FROM hq.tasks t
      LEFT JOIN public.campaign_quiz_backlog b ON b.hq_task_id = t.id
     WHERE t.assignee_id = m.id AND t.status = 'in_progress' AND t.claim_token IS NULL
       AND (b.id IS NULL OR b.status IN ('held', 'skipped'))
     FOR UPDATE OF t SKIP LOCKED
  LOOP
    UPDATE hq.tasks
       SET status = 'blocked', updated_at = now(),
           result = left('The page could not be built' ||
                         CASE WHEN r.item_status IS NULL THEN ': it is no longer on the build list.'
                              ELSE ' (' || r.item_status || ')' || COALESCE(': ' || r.last_error, '.') END, 4000)
     WHERE id = r.id;
    INSERT INTO hq.events (type, member_id, task_id, message)
    VALUES ('quiz_pages_failed', m.id, r.id, left(m.name || ' could not finish ' || r.title, 500));
  END LOOP;

  IF EXISTS (SELECT 1 FROM hq.tasks WHERE assignee_id = m.id AND kind <> 'chat'
               AND status = 'in_progress' AND claim_token IS NOT NULL) THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH next AS (
    SELECT t.id FROM hq.tasks t
     WHERE t.assignee_id = m.id AND t.kind IN ('task', 'proposal') AND t.status = 'todo'
       AND (t.founder_approved_at IS NOT NULL OR t.review_state = 'reopened')
       AND t.escalated_at IS NULL
     ORDER BY t.priority, t.position, t.number
     LIMIT 1
     FOR UPDATE SKIP LOCKED
  )
  UPDATE hq.tasks t
     SET status = 'in_progress', claimed_by = p_worker, claimed_at = now(),
         claim_token = gen_random_uuid(), attempts = t.attempts + 1, updated_at = now()
    FROM next
   WHERE t.id = next.id
  RETURNING t.*;
END;
$$;

-- Keeps a rework's claim alive. False: the claim is gone (cancelled, reassigned, recovered) — stop.
CREATE FUNCTION hq.quiz_pages_heartbeat(p_task uuid, p_claim_token uuid)
RETURNS boolean
LANGUAGE sql
SET search_path = hq, pg_temp
AS $$
  WITH hit AS (
    UPDATE hq.tasks SET claimed_at = now()
     WHERE id = p_task AND status = 'in_progress' AND claim_token = p_claim_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM hit);
$$;

-- A task asking for a new page: the page goes to the front of the build list
-- and the task waits for it (without an HQ claim). Returns the list item's id.
CREATE FUNCTION hq.quiz_pages_enqueue(
  p_task uuid, p_claim_token uuid, p_page_slug text, p_name text, p_kind text, p_markets text[]
)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  m hq.members := hq.quiz_pages_member();
  t hq.tasks;
  b public.campaign_quiz_backlog;
BEGIN
  SELECT * INTO t FROM hq.tasks WHERE id = p_task FOR UPDATE;
  IF t.id IS NULL OR m.id IS NULL OR t.assignee_id <> m.id OR t.status <> 'in_progress' OR t.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'quiz_pages: this run no longer holds the task' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM public.campaign_quizzes WHERE slug = p_page_slug) THEN
    RAISE EXCEPTION 'quiz_pages: % already exists; refresh it instead', p_page_slug USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO b FROM public.campaign_quiz_backlog WHERE page_slug = p_page_slug FOR UPDATE;
  IF b.id IS NULL THEN
    INSERT INTO public.campaign_quiz_backlog (page_slug, name, kind, markets, priority, hq_task_id)
    VALUES (p_page_slug, p_name, p_kind, COALESCE(p_markets, '{}'), 1, t.id)
    RETURNING * INTO b;
  ELSIF b.hq_task_id IS NOT NULL AND b.hq_task_id <> t.id
        AND EXISTS (SELECT 1 FROM hq.tasks o WHERE o.id = b.hq_task_id AND o.status = 'in_progress') THEN
    RAISE EXCEPTION 'quiz_pages: % is already being built for another task', p_page_slug USING ERRCODE = 'P0001';
  ELSIF b.status = 'published' THEN
    RAISE EXCEPTION 'quiz_pages: % was already published; refresh it instead', p_page_slug USING ERRCODE = 'P0001';
  ELSIF b.status = 'building' THEN
    UPDATE public.campaign_quiz_backlog SET hq_task_id = t.id, priority = LEAST(priority, 1), updated_at = now() WHERE id = b.id;
  ELSE
    -- Queued, held or skipped: a person asked for it again, so it gets a fresh start.
    UPDATE public.campaign_quiz_backlog
       SET hq_task_id = t.id, priority = LEAST(priority, 1), status = 'queued', attempts = 0,
           not_before = NULL, last_error = NULL, updated_at = now()
     WHERE id = b.id;
  END IF;

  UPDATE hq.tasks SET claimed_by = NULL, claimed_at = NULL, claim_token = NULL, updated_at = now() WHERE id = t.id;
  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES ('quiz_pages_queued', m.id, t.id, left(m.name || ' queued a page for ' || p_name, 500),
          jsonb_build_object('quiz_page', p_page_slug));
  RETURN b.id;
END;
$$;

-- Ends a claimed task without publishing: 'blocked' (out of scope, impossible
-- — the note says why), 'todo' (a passing failure; try again later) or 'done'
-- (nothing left to do, e.g. the page was just refreshed; p_ref names the page).
CREATE FUNCTION hq.quiz_pages_release(p_task uuid, p_claim_token uuid, p_status text, p_note text, p_ref jsonb DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  m hq.members := hq.quiz_pages_member();
  t hq.tasks;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF p_status NOT IN ('blocked', 'todo', 'done') THEN
    RAISE EXCEPTION 'quiz_pages_release: status must be blocked, todo or done' USING ERRCODE = 'P0001';
  END IF;
  IF p_status = 'done' AND (v_note IS NULL OR p_ref IS NULL OR NOT p_ref ? 'quiz_page' OR p_ref ? 'op_key') THEN
    RAISE EXCEPTION 'quiz_pages_release: done needs a note and the page it is about' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO t FROM hq.tasks WHERE id = p_task FOR UPDATE;
  IF t.id IS NULL OR m.id IS NULL OR t.assignee_id <> m.id OR t.status <> 'in_progress' OR t.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN false;
  END IF;
  UPDATE hq.tasks
     SET status = p_status, claimed_by = NULL, claimed_at = NULL, claim_token = NULL, updated_at = now(),
         result = CASE WHEN p_status IN ('blocked', 'done') THEN left(v_note, 20000) ELSE result END,
         completed_at = CASE WHEN p_status = 'done' THEN now() ELSE completed_at END,
         ref = CASE WHEN p_status = 'done' THEN p_ref ELSE ref END
   WHERE id = t.id;
  IF v_note IS NOT NULL AND p_status <> 'done' THEN
    INSERT INTO hq.messages (task_id, author_id, recipient_id, kind, body)
    VALUES (t.id, m.id, t.created_by_id, 'comment', left(v_note, 20000));
  END IF;
  IF p_status = 'blocked' THEN
    INSERT INTO hq.events (type, member_id, task_id, message)
    VALUES ('quiz_pages_blocked', m.id, t.id, left(m.name || ' could not do #' || t.number || ' ' || t.title || COALESCE(' — ' || v_note, ''), 500));
  END IF;
  RETURN true;
END;
$$;

-- Called by the backend inside the transaction that publishes a page version.
-- Finishes the task the work was for (a rework, or a queued page), or files a
-- new finished task for routine work, and supersedes older unreviewed reports
-- of the page. Refuses while the agent is paused or when the task it worked
-- for was cancelled or taken away — so the page isn't published either.
-- Returns the task number, or NULL when this environment has no such member.
CREATE FUNCTION hq.quiz_pages_report(
  p_op_key text, p_quiz_slug text, p_version integer, p_action text,
  p_title text, p_result text, p_task uuid, p_claim_token uuid, p_backlog uuid
)
RETURNS bigint
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
DECLARE
  m hq.members;
  v_task uuid := p_task;
  t hq.tasks;
  v_ref jsonb := jsonb_build_object('quiz_page', p_quiz_slug, 'version', p_version, 'action', p_action, 'op_key', p_op_key);
  v_number bigint;
BEGIN
  -- Locked until the page is published: a pause (or archive) committed meanwhile
  -- waits for this transaction, one committed before it is seen here. A share lock
  -- (and no write to the row) so concurrent publishes of other pages don't block.
  SELECT * INTO m FROM hq.members WHERE id = (hq.quiz_pages_member()).id FOR SHARE;
  IF m.id IS NULL THEN
    RETURN NULL;
  END IF;
  IF m.status <> 'active' THEN
    RAISE EXCEPTION 'quiz_pages_paused: % is paused in HQ', m.name USING ERRCODE = 'P0001';
  END IF;
  IF p_action NOT IN ('create', 'refresh', 'repair') THEN
    RAISE EXCEPTION 'quiz_pages_report: unknown action %', p_action USING ERRCODE = 'P0001';
  END IF;

  IF v_task IS NULL AND p_backlog IS NOT NULL THEN
    SELECT hq_task_id INTO v_task FROM public.campaign_quiz_backlog WHERE id = p_backlog;
  END IF;

  IF v_task IS NOT NULL THEN
    SELECT * INTO t FROM hq.tasks WHERE id = v_task FOR UPDATE;
    IF t.id IS NULL OR t.assignee_id <> m.id OR t.status <> 'in_progress'
       OR (p_task IS NOT NULL AND t.claim_token IS DISTINCT FROM p_claim_token) THEN
      RAISE EXCEPTION 'quiz_pages_task_lost: the HQ task this work was for was cancelled or taken away' USING ERRCODE = 'P0001';
    END IF;
    UPDATE hq.tasks
       SET status = 'done', completed_at = now(), result = left(p_result, 20000), ref = v_ref,
           claimed_by = NULL, claimed_at = NULL, claim_token = NULL, updated_at = now()
     WHERE id = t.id
    RETURNING number INTO v_number;
  ELSE
    INSERT INTO hq.tasks (title, body, status, priority, assignee_id, created_by_id, kind, result, ref, completed_at)
    VALUES (left(p_title, 200), '', 'done', 2, m.id, m.id, 'task', left(p_result, 20000), v_ref, now())
    RETURNING id, number INTO v_task, v_number;
  END IF;

  UPDATE hq.tasks
     SET review_state = 'superseded', reviewed_at = now(),
         review_note = 'Replaced by version ' || p_version || ' (#' || v_number || ')', updated_at = now()
   WHERE assignee_id = m.id AND id <> v_task AND status = 'done' AND review_state IS NULL AND escalated_at IS NULL
     AND ref ->> 'quiz_page' = p_quiz_slug
     AND (ref ->> 'version')::integer < p_version;

  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES ('quiz_pages_' || CASE p_action WHEN 'create' THEN 'published' WHEN 'refresh' THEN 'refreshed' ELSE 'reworked' END,
          m.id, v_task, left(m.name || ': ' || p_title, 500), v_ref);
  RETURN v_number;
END;
$$;

-- ── 4. the member (paused until the runner with HQ support is deployed) ───
INSERT INTO hq.members (slug, kind, name, title, avatar, color, department, description, instructions,
                        model, tools, autonomy, runtime, status, max_turns, role, tier)
VALUES (
  'quiz-pages', 'agent', 'Quiz Page Editor', 'SEO quiz pages', '📄', 'teal', 'growth',
  'Builds and refreshes the public SEO quiz pages (one per club, national team, league or quiz type) in 8 languages, with new fact-checked questions and artwork, and refreshes every page every two weeks. Give it a task to build a page (name the club, national team, league or quiz type), refresh a page, or fix something on a page. Every page it publishes comes back to you to check: open the links, check facts, names, language and the sign-up call to action; send it back with exactly what to change.',
  'Runs on its own pipeline on the VPS (quiz-page runner). Tasks: build a page, refresh a page, or fix a page. Anything else is out of scope and is blocked with the reason.',
  'codex:gpt-6-luna@high', '{}', 'autonomous', 'quiz_pages', 'paused', 25, 'agent', 'act'
)
ON CONFLICT (slug) DO NOTHING;

-- ── 5. grants ─────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION hq.quiz_pages_member() FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.quiz_pages_intake(text, interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.quiz_pages_heartbeat(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.quiz_pages_enqueue(uuid, uuid, text, text, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.quiz_pages_release(uuid, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION hq.quiz_pages_report(text, text, integer, text, text, text, uuid, uuid, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    -- The pipeline functions run as the caller and call the helper.
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.quiz_pages_member() TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.quiz_pages_intake(text, interval) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.quiz_pages_heartbeat(uuid, uuid) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.quiz_pages_enqueue(uuid, uuid, text, text, text, text[]) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION hq.quiz_pages_release(uuid, uuid, text, text, jsonb) TO service_role';
  END IF;
END;
$$;
