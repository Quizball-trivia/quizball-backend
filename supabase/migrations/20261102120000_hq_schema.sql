-- QuizBall HQ: a shared workspace where people (CMS admins) and AI agent
-- "employees" work a common task board.
--
--   members    people + agents (role, instructions, tools, autonomy, model)
--   tasks      the board; agents claim `todo` tasks assigned to them
--   schedules  cron rules that create tasks for an agent ("every day at 8")
--   messages   task threads and agent↔agent / human↔agent direct messages
--   runs       one row per agent execution (Agent SDK session, cost, log)
--   events     append-only activity feed
--   settings   singleton: HQ kill-switch + daily caps
--
-- The CMS reads/writes through the backend (`/api/v1/admin/hq`). The HQ worker
-- (quizball-question-agents, pm2 app `hq-worker`) claims tasks with
-- hq.claim_next_task() via the service role. Nothing here is exposed to
-- anon/authenticated; RLS is on with no policies as defence in depth.

CREATE SCHEMA IF NOT EXISTS hq;

-- ── members ────────────────────────────────────────────────────────────────
CREATE TABLE hq.members (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  kind            text NOT NULL CHECK (kind IN ('human', 'agent')),
  user_id         uuid UNIQUE REFERENCES public.users(id) ON DELETE SET NULL,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  title           text NOT NULL DEFAULT '',
  avatar          text NOT NULL DEFAULT '🤖',
  color           text NOT NULL DEFAULT 'slate',
  description     text NOT NULL DEFAULT '',
  -- Agents only: the role prompt the worker gives the model.
  instructions    text NOT NULL DEFAULT '',
  -- NULL = the worker's default model.
  model           text,
  -- Tool groups the worker may hand this agent: 'web', 'metrics', 'feedback'.
  -- Team tools (tasks/messages) are always available to HQ agents.
  tools           text[] NOT NULL DEFAULT '{}',
  autonomy        text NOT NULL DEFAULT 'autonomous' CHECK (autonomy IN ('autonomous', 'approval')),
  -- Who executes this agent. 'hq' = the HQ worker; the others are existing
  -- services shown on the team page but run by their own pipelines.
  runtime         text NOT NULL DEFAULT 'hq' CHECK (runtime IN ('hq', 'question_agents', 'bug_triage', 'none')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  max_turns       integer NOT NULL DEFAULT 25 CHECK (max_turns BETWEEN 1 AND 100),
  last_active_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hq_members_human_runtime CHECK (kind = 'agent' OR runtime = 'none'),
  CONSTRAINT hq_members_agent_runtime CHECK (kind = 'human' OR runtime <> 'none')
);

-- ── schedules ──────────────────────────────────────────────────────────────
CREATE TABLE hq.schedules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id     uuid NOT NULL REFERENCES hq.members(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- Standard 5-field cron, evaluated in `timezone` by the worker.
  cron          text NOT NULL,
  timezone      text NOT NULL DEFAULT 'Asia/Tbilisi',
  task_title    text NOT NULL CHECK (length(task_title) BETWEEN 1 AND 200),
  task_body     text NOT NULL DEFAULT '',
  enabled       boolean NOT NULL DEFAULT true,
  -- Filled by the worker; reset to NULL whenever cron/timezone change.
  next_run_at   timestamptz,
  last_run_at   timestamptz,
  last_task_id  uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hq_schedules_due_idx ON hq.schedules (next_run_at) WHERE enabled;

-- ── tasks ──────────────────────────────────────────────────────────────────
CREATE TABLE hq.tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body           text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'todo'
                 CHECK (status IN ('backlog', 'todo', 'in_progress', 'needs_approval', 'blocked', 'done', 'cancelled')),
  -- 0 urgent · 1 high · 2 normal · 3 low
  priority       smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),
  assignee_id    uuid REFERENCES hq.members(id) ON DELETE SET NULL,
  created_by_id  uuid REFERENCES hq.members(id) ON DELETE SET NULL,
  parent_id      uuid REFERENCES hq.tasks(id) ON DELETE SET NULL,
  -- Hand-off chain length; the worker refuses to create tasks past a cap so
  -- agents can't delegate in circles forever.
  depth          smallint NOT NULL DEFAULT 0 CHECK (depth BETWEEN 0 AND 20),
  schedule_id    uuid REFERENCES hq.schedules(id) ON DELETE SET NULL,
  -- Markdown deliverable written by whoever finished the task.
  result         text,
  -- Kanban ordering inside a column (lower = higher up).
  position       double precision NOT NULL DEFAULT extract(epoch FROM now()),
  attempts       integer NOT NULL DEFAULT 0,
  claimed_by     text,
  claimed_at     timestamptz,
  -- New random value per claim. The worker may only finish a task whose
  -- token still matches the one it claimed; any human status change (or
  -- reassignment) clears it, so a stale run can never overwrite newer state.
  claim_token    uuid,
  due_at         timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hq_tasks_status_idx   ON hq.tasks (status, priority, created_at);
CREATE INDEX hq_tasks_assignee_idx ON hq.tasks (assignee_id, status);
CREATE INDEX hq_tasks_parent_idx   ON hq.tasks (parent_id);

ALTER TABLE hq.schedules
  ADD CONSTRAINT hq_schedules_last_task_fk FOREIGN KEY (last_task_id) REFERENCES hq.tasks(id) ON DELETE SET NULL;

-- ── messages ───────────────────────────────────────────────────────────────
CREATE TABLE hq.messages (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id       uuid REFERENCES hq.tasks(id) ON DELETE CASCADE,
  author_id     uuid REFERENCES hq.members(id) ON DELETE SET NULL,
  -- Set for direct messages / @mentions; the recipient sees it in its inbox
  -- (agents get unread inbox messages in their next run's prompt).
  recipient_id  uuid REFERENCES hq.members(id) ON DELETE SET NULL,
  kind          text NOT NULL DEFAULT 'comment' CHECK (kind IN ('comment', 'handoff', 'system', 'result')),
  body          text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hq_messages_target CHECK (task_id IS NOT NULL OR recipient_id IS NOT NULL)
);
CREATE INDEX hq_messages_task_idx  ON hq.messages (task_id, created_at);
CREATE INDEX hq_messages_inbox_idx ON hq.messages (recipient_id, created_at) WHERE read_at IS NULL;

-- ── runs ───────────────────────────────────────────────────────────────────
CREATE TABLE hq.runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id       uuid NOT NULL REFERENCES hq.members(id) ON DELETE CASCADE,
  task_id         uuid REFERENCES hq.tasks(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'succeeded', 'failed', 'timeout', 'cancelled')),
  worker          text,
  model           text,
  sdk_session_id  text,
  turns           integer,
  tokens_in       integer,
  tokens_out      integer,
  -- Estimated (subscription usage isn't billed per call); used for the cap.
  cost_cents      integer NOT NULL DEFAULT 0,
  summary         text,
  error           text,
  -- Compact tool-call log: [{ts, tool, input, ok}]
  log             jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);
CREATE INDEX hq_runs_member_idx  ON hq.runs (member_id, started_at DESC);
CREATE INDEX hq_runs_task_idx    ON hq.runs (task_id);
CREATE INDEX hq_runs_started_idx ON hq.runs (started_at);
CREATE INDEX hq_runs_running_idx ON hq.runs (status) WHERE status = 'running';

-- ── events ─────────────────────────────────────────────────────────────────
CREATE TABLE hq.events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts         timestamptz NOT NULL DEFAULT now(),
  -- task_created · task_updated · task_status · run_started · run_finished ·
  -- message · handoff · schedule_fired · member_updated · settings
  type       text NOT NULL,
  level      text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  member_id  uuid REFERENCES hq.members(id) ON DELETE SET NULL,
  task_id    uuid REFERENCES hq.tasks(id) ON DELETE SET NULL,
  run_id     uuid REFERENCES hq.runs(id) ON DELETE SET NULL,
  message    text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX hq_events_ts_idx     ON hq.events (ts DESC);
CREATE INDEX hq_events_member_idx ON hq.events (member_id, ts DESC);

-- ── settings (singleton) ──────────────────────────────────────────────────
CREATE TABLE hq.settings (
  id                   boolean PRIMARY KEY DEFAULT true CHECK (id),
  paused               boolean NOT NULL DEFAULT false,
  paused_reason        text,
  daily_limit_cents    integer NOT NULL DEFAULT 2000 CHECK (daily_limit_cents >= 0),
  daily_run_limit      integer NOT NULL DEFAULT 150 CHECK (daily_run_limit >= 0),
  max_concurrent_runs  integer NOT NULL DEFAULT 2 CHECK (max_concurrent_runs BETWEEN 1 AND 10),
  updated_by           uuid REFERENCES public.users(id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO hq.settings (id) VALUES (true);

-- ── worker state transitions (each one atomic) ────────────────────────────
-- Hands the HQ worker the next `todo` task for an active HQ agent that isn't
-- already busy. "Busy" = it has an in_progress task OR a run still executing
-- (a human may have moved/cancelled the task while the old run is finishing;
-- runs older than 15 min are ignored — the worker's hard timeout is 9 min and
-- boot recovery closes orphans). One task per agent keeps its work and inbox
-- sequential and guarantees the same task never executes twice at once.
--
-- Claims are serialised with a transaction-level advisory lock: row locks
-- alone can't stop two concurrent claimers from each passing the busy check
-- and taking two different tasks of the same agent. Because this is plpgsql,
-- the UPDATE takes its snapshot after the lock is granted, so it sees the
-- previous claimer's committed row. The partial unique index below is the
-- hard backstop (only worker claims set claim_token).
CREATE UNIQUE INDEX hq_tasks_one_claim_per_agent
  ON hq.tasks (assignee_id)
  WHERE status = 'in_progress' AND claim_token IS NOT NULL;

CREATE FUNCTION hq.claim_next_task(p_worker text)
RETURNS SETOF hq.tasks
LANGUAGE plpgsql
SET search_path = hq, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('hq.claim_next_task'));
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

-- Finishes a claimed task. Only applies while the task is still
-- in_progress under the same claim token; returns false otherwise (a human
-- moved, cancelled or reassigned it mid-run — their change wins).
-- p_refund_attempt gives the attempt back (worker shutdown, not a failure).
CREATE FUNCTION hq.finish_task(
  p_task_id uuid,
  p_claim_token uuid,
  p_status text,
  p_result text,
  p_refund_attempt boolean DEFAULT false
)
RETURNS boolean
LANGUAGE sql
SET search_path = hq, pg_temp
AS $$
  WITH u AS (
    UPDATE hq.tasks
       SET status = p_status,
           result = COALESCE(p_result, result),
           completed_at = CASE WHEN p_status = 'done' THEN now() ELSE NULL END,
           attempts = CASE WHEN p_refund_attempt THEN GREATEST(attempts - 1, 0) ELSE attempts END,
           claimed_by = NULL,
           claimed_at = NULL,
           claim_token = NULL,
           updated_at = now()
     WHERE id = p_task_id
       AND status = 'in_progress'
       AND claim_token = p_claim_token
       AND p_status IN ('todo', 'needs_approval', 'blocked', 'done')
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u);
$$;

-- Fires one schedule occurrence: advances the slot AND creates the task in a
-- single transaction, guarded on the slot the caller saw. Returns the new
-- task id, or NULL if another tick already fired this slot / it was disabled.
CREATE FUNCTION hq.fire_schedule(
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
BEGIN
  UPDATE hq.schedules
     SET next_run_at = p_new_next, last_run_at = now(), updated_at = now()
   WHERE id = p_schedule_id AND enabled AND next_run_at = p_expected_next
  RETURNING * INTO s;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  INSERT INTO hq.tasks (title, body, status, assignee_id, schedule_id)
  VALUES (left(p_title, 200), s.task_body, 'todo', s.member_id, s.id)
  RETURNING id INTO v_task;

  UPDATE hq.schedules SET last_task_id = v_task WHERE id = s.id;

  INSERT INTO hq.events (type, member_id, task_id, message, data)
  VALUES ('schedule_fired', s.member_id, v_task, 'Schedule "' || s.name || '" created a task',
          jsonb_build_object('schedule_id', s.id, 'slot', p_expected_next));
  RETURN v_task;
END;
$$;

-- Today's (Tbilisi) HQ usage, aggregated server-side (PostgREST caps rows).
CREATE FUNCTION hq.today_usage()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = hq, pg_temp
AS $$
  SELECT jsonb_build_object(
    'runs', count(*),
    'cost_cents', COALESCE(sum(r.cost_cents), 0),
    'running', count(*) FILTER (WHERE r.status = 'running')
  )
    FROM hq.runs r
   WHERE r.started_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Tbilisi') AT TIME ZONE 'Asia/Tbilisi');
$$;

-- ── read-only data tools for agents ───────────────────────────────────────
-- Day buckets are in Tbilisi time, matching the rest of the CMS.
CREATE FUNCTION hq.metrics_snapshot(p_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = hq, public, pg_temp
AS $$
  WITH win AS (
    SELECT now() - make_interval(days => LEAST(GREATEST(p_days, 1), 90)) AS since
  ),
  real_users AS (
    SELECT u.id, u.created_at
      FROM public.users u
     WHERE NOT u.is_ai AND NOT u.is_seed AND NOT u.is_guest AND NOT u.is_deleted
  ),
  -- Bot-only matches (e.g. bot burn-in) are written with is_dev = false, so
  -- also require at least one real player, like adminStatsRepo.gamesPerDay().
  real_matches AS (
    SELECT m.id, m.mode, m.status, m.started_at
      FROM public.matches m, win
     WHERE NOT m.is_dev
       AND m.started_at >= win.since
       AND EXISTS (
         SELECT 1 FROM public.match_players mp
           JOIN real_users ru ON ru.id = mp.user_id
          WHERE mp.match_id = m.id
       )
  )
  SELECT jsonb_build_object(
    'generated_at', now(),
    'timezone', 'Asia/Tbilisi',
    'days', LEAST(GREATEST(p_days, 1), 90),
    'total_registered_users', (SELECT count(*) FROM real_users),
    'new_users_by_day', COALESCE((
      SELECT jsonb_object_agg(day, n) FROM (
        SELECT (ru.created_at AT TIME ZONE 'Asia/Tbilisi')::date::text AS day, count(*) AS n
          FROM real_users ru, win WHERE ru.created_at >= win.since GROUP BY 1
      ) s), '{}'::jsonb),
    'matches_by_day', COALESCE((
      SELECT jsonb_object_agg(day, n) FROM (
        SELECT (rm.started_at AT TIME ZONE 'Asia/Tbilisi')::date::text AS day, count(*) AS n
          FROM real_matches rm GROUP BY 1
      ) s), '{}'::jsonb),
    'matches_by_mode', COALESCE((
      SELECT jsonb_object_agg(mode, n) FROM (
        SELECT rm.mode, count(*) AS n FROM real_matches rm GROUP BY 1
      ) s), '{}'::jsonb),
    'matches_by_status', COALESCE((
      SELECT jsonb_object_agg(status, n) FROM (
        SELECT rm.status, count(*) AS n FROM real_matches rm GROUP BY 1
      ) s), '{}'::jsonb),
    'active_players_by_day', COALESCE((
      SELECT jsonb_object_agg(day, n) FROM (
        SELECT (rm.started_at AT TIME ZONE 'Asia/Tbilisi')::date::text AS day,
               count(DISTINCT mp.user_id) AS n
          FROM real_matches rm
          JOIN public.match_players mp ON mp.match_id = rm.id
          JOIN real_users ru ON ru.id = mp.user_id
         GROUP BY 1
      ) s), '{}'::jsonb)
  );
$$;

CREATE FUNCTION hq.recent_feedback(p_days integer DEFAULT 7, p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = hq, public, pg_temp
AS $$
  -- A returning player's resubmission replaces their row and only advances
  -- updated_at, so recency is judged by updated_at.
  SELECT COALESCE(jsonb_agg(f ORDER BY f.submitted_at DESC), '[]'::jsonb)
    FROM (
      SELECT g.game, g.mode, g.rating, g.comment, g.locale, g.updated_at AS submitted_at
        FROM public.game_feedback g
       WHERE g.updated_at >= now() - make_interval(days => LEAST(GREATEST(p_days, 1), 90))
       ORDER BY g.updated_at DESC
       LIMIT LEAST(GREATEST(p_limit, 1), 500)
    ) f;
$$;

-- ── access ─────────────────────────────────────────────────────────────────
ALTER TABLE hq.members   ENABLE ROW LEVEL SECURITY;
ALTER TABLE hq.schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE hq.tasks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE hq.messages  ENABLE ROW LEVEL SECURITY;
ALTER TABLE hq.runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE hq.events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE hq.settings  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON SCHEMA hq FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hq FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA hq FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA hq FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA hq TO service_role';
    EXECUTE 'GRANT ALL ON ALL TABLES IN SCHEMA hq TO service_role';
    EXECUTE 'GRANT ALL ON ALL SEQUENCES IN SCHEMA hq TO service_role';
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA hq TO service_role';
  END IF;
END $$;

-- ── seed: the starting team ───────────────────────────────────────────────
-- People: every current CMS admin.
INSERT INTO hq.members (slug, kind, user_id, name, title, avatar, color, runtime)
SELECT
  'u-' || substr(replace(u.id::text, '-', ''), 1, 12),
  'human',
  u.id,
  COALESCE(NULLIF(left(btrim(u.nickname), 80), ''), NULLIF(left(split_part(COALESCE(u.email, ''), '@', 1), 80), ''), 'Admin'),
  'Team',
  '🧑',
  'slate',
  'none'
FROM public.users u
WHERE u.role = 'admin' AND NOT u.is_deleted
ON CONFLICT DO NOTHING;

-- Existing pipelines, shown on the board but run by their own services.
INSERT INTO hq.members (slug, kind, name, title, avatar, color, description, runtime) VALUES
  ('question-writer', 'agent', 'Question Writer', 'Content', '✍️', 'violet',
   'The question-generation pipeline (generate → dedupe → fact-check → judge). Runs on the VPS as qa-producer/qa-worker; managed from Agents & VPS.',
   'question_agents'),
  ('bug-fixer', 'agent', 'Bug Fixer', 'Engineering', '🛠️', 'red',
   'Reads bug reports from the support inbox, fixes understood bugs in a worktree and opens draft PRs against backend/web.',
   'bug_triage');

-- New HQ employees.
INSERT INTO hq.members (slug, kind, name, title, avatar, color, description, tools, instructions) VALUES
  ('ops-reporter', 'agent', 'Ops Reporter', 'Operations', '📊', 'blue',
   'Every morning: the state of QuizBall in one page — players, matches, feedback, what the team did overnight, and what needs a human.',
   ARRAY['metrics', 'feedback'],
   $i$You are the Ops Reporter at QuizBall, a football trivia game (web at quizball.io, a mobile app, real-time 1v1 matches, daily games). Your job is a short, honest daily briefing for the founder.

Each run:
1. Call hq_metrics (7 days) and hq_feedback (2 days). Call hq_list_tasks to see what the team did and what is stuck or waiting for approval.
2. Write the briefing as your result, in Markdown, under ~350 words:
   - **Headline**: one sentence on how yesterday went.
   - **Numbers**: new users, matches, active players — yesterday vs. the 7-day average, with the % change. Only use numbers the tools returned; never invent or estimate.
   - **Players are saying**: 2–4 themes from feedback, with a short quote each.
   - **Team**: what agents finished, what is blocked, what is waiting for approval.
   - **Needs you**: concrete decisions for the founder (or "Nothing today").
3. If you see something alarming (matches down >30% day over day, a spike of 1–2 star ratings), create an urgent task for the right teammate instead of just mentioning it.$i$),
  ('reviews-analyst', 'agent', 'Reviews Analyst', 'Product', '🔎', 'amber',
   'Reads player feedback and reviews, groups complaints into themes, and turns real problems into tasks for the right teammate.',
   ARRAY['feedback', 'web'],
   $i$You are the Reviews & Feedback Analyst at QuizBall, a football trivia game. You turn what players say into work.

Each run:
1. Read recent in-game feedback with hq_feedback. If the task gives store listing URLs, read those reviews with WebFetch.
2. Group feedback into themes (bugs, content errors such as wrong answers, difficulty, UX, feature requests). Count how often each appears and keep 1–2 verbatim quotes.
3. Before creating tasks, call hq_list_tasks so you don't duplicate open work. Then:
   - Clear bugs → a task for `bug-fixer` with steps, platform and quotes.
   - Wrong / outdated questions → a task for `question-writer`.
   - Product or UX ideas → a task for a human (leave assignee empty) at low priority.
   Create at most 5 tasks per run; merge similar items.
4. Your result: a Markdown report of themes, counts, quotes and the tasks you created.$i$),
  ('qa-tester', 'agent', 'QA Tester', 'Engineering', '🧪', 'emerald',
   'Checks the live and staging sites for broken pages, errors and regressions, and files bugs with clear repro steps.',
   ARRAY['web'],
   $i$You are the QA Tester at QuizBall (quizball.io), a football trivia game. You find problems before players do.

Each run:
1. Fetch the pages listed in the task (default: https://quizball.io and its main sections linked from the home page). Check that each loads, has sensible content, and has no obvious error text, broken links in navigation, missing translations (raw keys like "home.title") or placeholder text.
2. Note what you could and could not verify: you read pages over HTTP; you cannot click, log in or play a match yet. Say so plainly instead of guessing.
3. For each real problem, check hq_list_tasks for an existing task, then create one for `bug-fixer` with URL, what you expected, what you saw, and severity. At most 5 per run.
4. Your result: a pass/fail checklist of pages and the tasks you filed.$i$),
  ('growth-writer', 'agent', 'Growth Writer', 'Marketing', '📣', 'pink',
   'Drafts push notifications, store listing copy and announcement text from new features and real game stats.',
   ARRAY['metrics', 'web'],
   $i$You are the Growth & Marketing Writer at QuizBall, a football trivia game played by football fans (core markets include Georgia; the game is localized into several languages).

Your job is copy that brings players back and brings new ones in: push notifications, store listing text, in-app announcements and email subject lines.
- Ground claims in real numbers from hq_metrics or facts in the task. Never invent stats, prizes or features.
- Keep the voice energetic and football-native, never spammy. Push notifications: ≤ 60 characters for the title, ≤ 120 for the body.
- When the task names a language, write in that language; for Georgian, write natural Georgian, not a literal translation.
- Give 3 options for anything short (pushes, subject lines) and explain which you'd pick and why.
Your result: the copy, ready to paste, in Markdown.$i$),
  ('social-media-manager', 'agent', 'Social Media Manager', 'Marketing', '📱', 'sky',
   'Plans the social calendar and writes posts for Instagram, TikTok, X and Facebook around football moments and QuizBall features.',
   ARRAY['metrics', 'web'],
   $i$You are the Social Media Manager at QuizBall, a football trivia game.

Each run, produce a content plan and ready-to-post drafts:
1. Use WebSearch to find football moments for the coming days (big matches, transfers, birthdays of famous players, anniversaries).
2. Tie each moment to QuizBall: a trivia question people can answer in the comments, a "can you beat this score" challenge, a feature highlight. Use hq_metrics for any real numbers you mention.
3. For each post give: platform, suggested date/time (Tbilisi time), caption, hashtags, and a visual brief (what the image/video should show).
4. Never post on behalf of real clubs or players or imply partnerships. Check facts in trivia questions with a second source.
Your result: a Markdown content calendar with the drafts. Hand any image/video production needs to a human as a task (leave assignee empty).$i$);

-- Starting schedules (Tbilisi time). Each creates a task for its agent.
INSERT INTO hq.schedules (member_id, name, cron, task_title, task_body)
SELECT m.id, s.name, s.cron, s.task_title, s.task_body
FROM (VALUES
  ('ops-reporter',         'Morning briefing',         '0 8 * * *',   'Daily briefing',                'Write today''s founder briefing.'),
  ('reviews-analyst',      'Nightly feedback review',  '0 3 * * *',   'Review the last day of feedback', 'Review player feedback from the last 24 hours and file tasks for real problems.'),
  ('qa-tester',            'Nightly site check',       '30 3 * * *',  'Nightly site check',            'Check https://quizball.io and the main sections linked from its home page.'),
  ('social-media-manager', 'Weekly content plan',      '0 10 * * 1',  'Plan this week''s social posts', 'Plan and draft social posts for the next 7 days.'),
  ('growth-writer',        'Weekly push notifications','0 11 * * 1',  'Draft this week''s push notifications', 'Draft 3 push notifications for this week based on the latest stats.')
) AS s(slug, name, cron, task_title, task_body)
JOIN hq.members m ON m.slug = s.slug;
