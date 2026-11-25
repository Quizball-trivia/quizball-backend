-- QuizBall HQ harness core (content section, first slice: Classic ranked).
--
-- The new HQ is run by agents: code hands an agent ONE job with everything it
-- needs, the agent returns a typed result, and code (the state machine in the
-- harness worker + harness.transition below) decides what happens next.
-- Agents never create work or move items themselves.
--
--   settings   singleton: pause switch and run caps
--   accounts   model accounts (Claude seats, Codex); secrets stay on the worker
--   agents     agent definitions: role, model, account + fallbacks
--   contracts  versioned content contracts per game mode (Games writes these)
--   policies   rules agents follow (Tato / the owners write these)
--   briefs     work orders created by triggers
--   items      content items moving through stages
--   jobs       the work queue: one job per item x step, claimed with a lease
--   verdicts   checker results
--   runs       one row per agent execution (account, model, tokens, cost)
--   events     append-only activity log
--
-- The old `hq` schema is left untouched as an archive.
-- Like `hq`, nothing here is exposed to anon/authenticated; RLS is on with no
-- policies. The worker uses the service role through PostgREST, so `harness`
-- must be listed in Supabase -> Settings -> API -> Exposed schemas.

CREATE SCHEMA IF NOT EXISTS harness;

-- ── settings ───────────────────────────────────────────────────────────────
CREATE TABLE harness.settings (
  id                   boolean PRIMARY KEY DEFAULT true CHECK (id),
  paused               boolean NOT NULL DEFAULT true,
  paused_reason        text,
  max_concurrent_runs  integer NOT NULL DEFAULT 3 CHECK (max_concurrent_runs BETWEEN 0 AND 50),
  daily_run_limit      integer NOT NULL DEFAULT 1500 CHECK (daily_run_limit BETWEEN 0 AND 100000),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- Starts paused: the owner switches it on once accounts are configured.
INSERT INTO harness.settings (id, paused, paused_reason)
VALUES (true, true, 'New harness: switch on once the agent accounts are configured on the worker');

-- ── accounts ───────────────────────────────────────────────────────────────
CREATE TABLE harness.accounts (
  id                  text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  provider            text NOT NULL CHECK (provider IN ('claude', 'codex')),
  label               text NOT NULL,
  -- Name of the environment variable on the worker that holds the secret
  -- (Claude: an OAuth token; Codex: a CODEX_HOME directory). Never the secret.
  secret_ref          text NOT NULL CHECK (secret_ref ~ '^[A-Z][A-Z0-9_]{2,80}$'),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- A seat kept for people. Agents never use it, not even as a fallback.
  reserved_for_people boolean NOT NULL DEFAULT false,
  -- Stop routing to this account once a usage window passes this share.
  soft_pct            integer NOT NULL DEFAULT 90 CHECK (soft_pct BETWEEN 1 AND 100),
  state               text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'limit', 'auth')),
  blocked_until       timestamptz,
  windows             jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error          text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT harness_accounts_people_never_active CHECK (NOT reserved_for_people OR status = 'disabled')
);

-- ── agents ─────────────────────────────────────────────────────────────────
CREATE TABLE harness.agents (
  slug               text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name               text NOT NULL,
  team               text NOT NULL CHECK (team IN ('sensing', 'suggesting', 'making', 'checking', 'localization', 'foundation', 'live')),
  description        text NOT NULL DEFAULT '',
  provider           text NOT NULL CHECK (provider IN ('claude', 'codex')),
  model              text NOT NULL,
  effort             text,
  primary_account    text NOT NULL REFERENCES harness.accounts(id),
  fallback_accounts  text[] NOT NULL DEFAULT '{}',
  -- 'wait' = never fall back (checkers: a Claude check of Claude-made content
  -- is not independent).
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  max_turns          integer NOT NULL DEFAULT 12 CHECK (max_turns BETWEEN 1 AND 100),
  timeout_ms         integer NOT NULL DEFAULT 480000 CHECK (timeout_ms BETWEEN 30000 AND 540000),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- Checking is always done by a different model family from the makers.
  CONSTRAINT harness_agents_checkers_on_codex CHECK (team <> 'checking' OR provider = 'codex')
);

-- ── contracts / policies ───────────────────────────────────────────────────
CREATE TABLE harness.contracts (
  mode        text NOT NULL CHECK (mode ~ '^[a-z0-9][a-z0-9_-]{1,40}$'),
  version     integer NOT NULL CHECK (version > 0),
  active      boolean NOT NULL DEFAULT true,
  body        jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mode, version)
);
CREATE UNIQUE INDEX harness_contracts_one_active ON harness.contracts (mode) WHERE active;

CREATE TABLE harness.policies (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9_.-]{1,80}$'),
  value       jsonb NOT NULL,
  note        text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── briefs ─────────────────────────────────────────────────────────────────
CREATE TABLE harness.briefs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode              text NOT NULL,
  contract_version  integer NOT NULL,
  category_id       uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  difficulty        text NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  count             integer NOT NULL CHECK (count BETWEEN 1 AND 50),
  reason            text NOT NULL,
  -- Angles from the Planner, recent topics to avoid, etc.
  plan              jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mode, contract_version) REFERENCES harness.contracts(mode, version)
);
CREATE INDEX harness_briefs_open ON harness.briefs (mode, category_id) WHERE status = 'open';

-- ── items ──────────────────────────────────────────────────────────────────
CREATE TABLE harness.items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode              text NOT NULL,
  contract_version  integer NOT NULL,
  brief_id          uuid REFERENCES harness.briefs(id) ON DELETE SET NULL,
  category_id       uuid REFERENCES public.categories(id) ON DELETE SET NULL,
  difficulty        text NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  stage             text NOT NULL DEFAULT 'draft' CHECK (stage IN (
                      'draft', 'validated', 'verified', 'localized', 'approved',
                      'live', 'resting', 'retired', 'rejected', 'escalated')),
  -- Compare-and-set counter: every transition bumps it.
  version           integer NOT NULL DEFAULT 0,
  payload           jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  sources           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(sources) = 'array'),
  -- Per locale: {"ka": "checked", ...}
  locales           jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(locales) = 'object'),
  scope             jsonb NOT NULL DEFAULT '{"kind":"global"}'::jsonb,
  revise_count      integer NOT NULL DEFAULT 0 CHECK (revise_count BETWEEN 0 AND 10),
  last_issues       jsonb NOT NULL DEFAULT '[]'::jsonb,
  question_id       uuid REFERENCES public.questions(id) ON DELETE SET NULL,
  -- When the item's question was written. Set with question_id; stays set if
  -- an editor later deletes the question (question_id goes NULL), so recovery
  -- can tell a deleted question from a release that never happened.
  released_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mode, contract_version) REFERENCES harness.contracts(mode, version)
);
CREATE INDEX harness_items_stage ON harness.items (mode, stage);
CREATE INDEX harness_items_category_open ON harness.items (category_id)
  WHERE stage IN ('draft', 'validated', 'verified', 'localized', 'approved');

-- ── jobs (the work queue) ──────────────────────────────────────────────────
CREATE TABLE harness.jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('plan', 'make', 'fact_check', 'quality_judge', 'localize', 'locale_check')),
  agent_slug    text NOT NULL REFERENCES harness.agents(slug),
  item_id       uuid REFERENCES harness.items(id) ON DELETE CASCADE,
  brief_id      uuid REFERENCES harness.briefs(id) ON DELETE CASCADE,
  -- The item version the job was created for: a result for an older version is stale.
  item_version  integer,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  priority      smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 9),
  input         jsonb NOT NULL DEFAULT '{}'::jsonb,
  result        jsonb,
  error         text,
  attempts      integer NOT NULL DEFAULT 0,
  max_attempts  integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  lease_owner   text,
  lease_token   uuid,
  lease_until   timestamptz,
  not_before    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  CONSTRAINT harness_jobs_target CHECK (item_id IS NOT NULL OR brief_id IS NOT NULL),
  CONSTRAINT harness_jobs_lease CHECK (status <> 'running' OR (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
-- At most one live job per item and step: a retried trigger cannot double the work.
CREATE UNIQUE INDEX harness_jobs_one_live_per_item ON harness.jobs (item_id, kind)
  WHERE item_id IS NOT NULL AND status IN ('queued', 'running');
CREATE UNIQUE INDEX harness_jobs_one_live_per_brief ON harness.jobs (brief_id, kind)
  WHERE item_id IS NULL AND status IN ('queued', 'running');
CREATE INDEX harness_jobs_queue ON harness.jobs (priority, created_at) WHERE status = 'queued';
CREATE INDEX harness_jobs_running ON harness.jobs (lease_until) WHERE status = 'running';

-- ── verdicts / runs / events ───────────────────────────────────────────────
CREATE TABLE harness.verdicts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES harness.items(id) ON DELETE CASCADE,
  job_id      uuid REFERENCES harness.jobs(id) ON DELETE SET NULL,
  -- The item version that was judged; verdicts on older versions never count.
  item_version integer NOT NULL,
  agent_slug  text NOT NULL REFERENCES harness.agents(slug),
  kind        text NOT NULL CHECK (kind IN ('fact', 'quality', 'locale')),
  decision    text NOT NULL CHECK (decision IN ('pass', 'revise', 'reject')),
  score       numeric(4, 2),
  issues      jsonb NOT NULL DEFAULT '[]'::jsonb,
  sources     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX harness_verdicts_item ON harness.verdicts (item_id, created_at DESC);

CREATE TABLE harness.runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       uuid REFERENCES harness.jobs(id) ON DELETE SET NULL,
  agent_slug   text NOT NULL REFERENCES harness.agents(slug),
  account_id   text REFERENCES harness.accounts(id),
  provider     text NOT NULL,
  model        text NOT NULL,
  prompt_version text NOT NULL,
  worker       text NOT NULL,
  status       text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'timeout', 'cancelled')),
  tokens_in    integer NOT NULL DEFAULT 0,
  tokens_out   integer NOT NULL DEFAULT 0,
  cost_cents   integer NOT NULL DEFAULT 0,
  error        text,
  output       text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz
);
CREATE INDEX harness_runs_started ON harness.runs (started_at DESC);
CREATE INDEX harness_runs_agent ON harness.runs (agent_slug, started_at DESC);

CREATE TABLE harness.events (
  id          bigserial PRIMARY KEY,
  type        text NOT NULL,
  level       text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error')),
  message     text NOT NULL,
  item_id     uuid,
  job_id      uuid,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX harness_events_created ON harness.events (created_at DESC);

-- ── queue functions ────────────────────────────────────────────────────────

-- Claims made per Tbilisi day: the daily cap is reserved at claim time, so
-- several workers cannot all pass the check for the last free slot.
CREATE TABLE harness.daily_claims (
  day  date PRIMARY KEY,
  n    integer NOT NULL DEFAULT 0
);

-- Leases for work that must run on one worker at a time (the health check).
CREATE TABLE harness.trigger_leases (
  name   text PRIMARY KEY,
  owner  text NOT NULL,
  until  timestamptz NOT NULL
);

-- Claims the next runnable job. Nothing is claimed while the harness is
-- paused, for paused agents, past today's run cap or at the concurrency cap.
-- Admission is serialized, so the caps hold with several workers.
CREATE FUNCTION harness.claim_job(p_worker text, p_lease_seconds integer DEFAULT 600)
RETURNS SETOF harness.jobs
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  s harness.settings;
  v_day date := (now() AT TIME ZONE 'Asia/Tbilisi')::date;
  j harness.jobs;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 3600 THEN
    RAISE EXCEPTION 'lease must be 30..3600 seconds' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('harness.claim_job'));
  SELECT * INTO s FROM harness.settings WHERE id;
  IF s.paused THEN RETURN; END IF;
  IF coalesce((SELECT n FROM harness.daily_claims WHERE day = v_day), 0) >= s.daily_run_limit THEN RETURN; END IF;
  -- Running jobs, plus agent runs still executing for jobs that were cancelled
  -- under them (a superseded checker keeps running until its model answers).
  IF (SELECT count(*) FROM harness.jobs WHERE status = 'running')
     + (SELECT count(*) FROM harness.runs r
         WHERE r.status = 'running' AND r.started_at > now() - interval '15 minutes'
           AND NOT EXISTS (SELECT 1 FROM harness.jobs x WHERE x.id = r.job_id AND x.status = 'running'))
     >= s.max_concurrent_runs THEN RETURN; END IF;

  UPDATE harness.jobs x
     SET status = 'running',
         lease_owner = p_worker,
         lease_token = gen_random_uuid(),
         lease_until = now() + make_interval(secs => p_lease_seconds),
         attempts = x.attempts + 1,
         started_at = now()
   WHERE x.id = (
     SELECT c.id
       FROM harness.jobs c
       JOIN harness.agents a ON a.slug = c.agent_slug
      WHERE c.status = 'queued'
        AND c.not_before <= now()
        AND a.status = 'active'
        -- an item job is only worth running while its item is still at that version
        AND (c.item_id IS NULL OR EXISTS (SELECT 1 FROM harness.items i WHERE i.id = c.item_id AND i.version = c.item_version))
      ORDER BY c.priority, c.created_at
      LIMIT 1
      FOR UPDATE OF c SKIP LOCKED
   )
  RETURNING x.* INTO j;
  IF j.id IS NULL THEN RETURN; END IF;

  INSERT INTO harness.daily_claims (day, n) VALUES (v_day, 1)
  ON CONFLICT (day) DO UPDATE SET n = harness.daily_claims.n + 1;
  RETURN NEXT j;
END;
$$;

-- Lock order everywhere: item row first, then its jobs (harness.transition
-- updates the item, then its jobs). finish_job and release_expired_leases lock
-- the item before the job for the same reason, so they cannot deadlock with a
-- transition.
--
-- A job that has given up for good must not keep holding inventory: its open
-- brief is cancelled, its item (if still at the job's version) is escalated.
-- Otherwise health checks would keep counting work nobody will finish.
CREATE FUNCTION harness.job_gave_up(p_job uuid, p_reason text)
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
      -- Its other live jobs judged the old version: stop them now.
      UPDATE harness.jobs SET status = 'cancelled', finished_at = now(), error = 'item escalated',
             lease_owner = NULL, lease_token = NULL, lease_until = NULL
       WHERE item_id = j.item_id AND status IN ('queued', 'running') AND id <> j.id;
      INSERT INTO harness.events (type, level, message, item_id, job_id)
      VALUES ('item_stage', 'warn', format('escalated: %s gave up', j.kind), j.item_id, j.id);
    END IF;
  ELSIF j.brief_id IS NOT NULL THEN
    UPDATE harness.briefs SET status = 'cancelled', updated_at = now() WHERE id = j.brief_id AND status = 'open';
  END IF;
END;
$$;

-- Finishes a claimed job. Refused (false) when the lease was lost: another
-- worker may already own the job, so its result must not be written twice.
-- A job its own transition already closed (see harness.transition) only
-- gets its result recorded.
--   done / failed  final
--   retry          the attempt counts; queued again with a growing wait, failed when out of attempts
--   defer          the attempt does not count (no account free, account limit): queued again at p_not_before
CREATE FUNCTION harness.finish_job(p_job uuid, p_token uuid, p_status text, p_result jsonb, p_error text, p_not_before timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  j harness.jobs;
  v_claim_day date;
BEGIN
  IF p_status NOT IN ('done', 'failed', 'retry', 'defer') THEN
    RAISE EXCEPTION 'status must be done, failed, retry or defer' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM harness.items WHERE id = (SELECT item_id FROM harness.jobs WHERE id = p_job) FOR UPDATE;
  SELECT * INTO j FROM harness.jobs WHERE id = p_job AND lease_token = p_token FOR UPDATE;
  IF j.id IS NULL THEN RETURN false; END IF;
  IF j.status = 'done' THEN
    -- Closed by its own transition: keep the result, nothing else changes.
    UPDATE harness.jobs SET result = coalesce(p_result, result), lease_owner = NULL, lease_token = NULL, lease_until = NULL WHERE id = p_job;
    RETURN true;
  END IF;
  IF j.status <> 'running' THEN RETURN false; END IF;
  v_claim_day := (j.started_at AT TIME ZONE 'Asia/Tbilisi')::date;

  UPDATE harness.jobs
     SET status = CASE
                    WHEN p_status = 'defer' THEN 'queued'
                    WHEN p_status = 'retry' AND attempts < max_attempts THEN 'queued'
                    WHEN p_status = 'retry' THEN 'failed'
                    ELSE p_status END,
         attempts = CASE WHEN p_status = 'defer' THEN greatest(attempts - 1, 0) ELSE attempts END,
         result = p_result,
         error = left(p_error, 2000),
         -- a retried job waits a little longer each time; a deferred one until its account frees up
         not_before = CASE
                        WHEN p_status = 'defer' THEN greatest(coalesce(p_not_before, now() + interval '5 minutes'), now() + interval '1 minute')
                        WHEN p_status = 'retry' THEN now() + make_interval(secs => 60 * attempts)
                        ELSE not_before END,
         started_at = CASE WHEN p_status = 'defer' THEN NULL ELSE started_at END,
         finished_at = CASE WHEN p_status = 'defer' OR (p_status = 'retry' AND attempts < max_attempts) THEN NULL ELSE now() END,
         lease_owner = NULL, lease_token = NULL, lease_until = NULL
   WHERE id = p_job
  RETURNING * INTO j;

  -- A deferred claim ran no agent: give its daily slot back.
  IF p_status = 'defer' THEN
    -- refunded to the day the claim was charged to, even across midnight
    UPDATE harness.daily_claims SET n = greatest(n - 1, 0) WHERE day = v_claim_day;
  END IF;
  IF j.status = 'failed' THEN PERFORM harness.job_gave_up(j.id, p_error); END IF;
  RETURN true;
END;
$$;

-- Returns jobs whose worker died (lease expired) to the queue, or fails them
-- once their attempts are used up. Returns how many were touched.
CREATE FUNCTION harness.release_expired_leases()
RETURNS integer
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  n integer := 0;
  e record;
  st text;
  expired_ids uuid[] := '{}';
BEGIN
  -- One recovery at a time, items in a fixed order: concurrent calls cannot deadlock.
  PERFORM pg_advisory_xact_lock(hashtext('harness.release_expired_leases'));
  FOR e IN SELECT id, item_id FROM harness.jobs WHERE status = 'running' AND lease_until < now() ORDER BY item_id NULLS FIRST, id LOOP
    PERFORM 1 FROM harness.items WHERE id = e.item_id FOR UPDATE;
    UPDATE harness.jobs
       SET status = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
           error = 'lease expired: the worker stopped before finishing',
           finished_at = CASE WHEN attempts < max_attempts THEN NULL ELSE now() END,
           lease_owner = NULL, lease_token = NULL, lease_until = NULL
     WHERE id = e.id AND status = 'running' AND lease_until < now()
    RETURNING status INTO st;
    IF FOUND THEN
      n := n + 1;
      expired_ids := expired_ids || e.id;
      IF st = 'failed' THEN PERFORM harness.job_gave_up(e.id, 'the worker stopped before finishing, out of attempts'); END IF;
    END IF;
  END LOOP;
  -- Close the runs of the workers that stopped, and any run left open past the
  -- longest possible agent call (abandoned). A run whose job was merely
  -- superseded may still be executing: it keeps its concurrency slot.
  UPDATE harness.runs SET status = 'cancelled', ended_at = now(), error = coalesce(error, 'lease expired')
   WHERE status = 'running' AND (job_id = ANY (expired_ids) OR started_at < now() - interval '15 minutes');
  RETURN n;
END;
$$;

-- The one way an item changes stage. Compare-and-set on (stage, version) so a
-- stale or duplicate result cannot move an item twice; the patch and the next
-- jobs land in the same transaction. Returns the updated item, or nothing when
-- the item had already moved on.
--   p_patch keys allowed: payload, sources, locales, revise_count, last_issues, question_id
--   p_jobs: [{kind, agent_slug, priority?, input?}]
--   p_current_job, p_current_token: the job whose result caused this
--     transition and the lease it ran under. It is closed here (done), so a
--     follow-up of the same kind can be queued now; a lost lease refuses it.
-- Every other live job of the item belongs to an older version and is
-- cancelled, running ones included: their results would be stale.
CREATE FUNCTION harness.transition(
  p_item uuid,
  p_from_stage text,
  p_version integer,
  p_to_stage text,
  p_patch jsonb DEFAULT '{}'::jsonb,
  p_jobs jsonb DEFAULT '[]'::jsonb,
  p_current_job uuid DEFAULT NULL,
  p_current_token uuid DEFAULT NULL
)
RETURNS SETOF harness.items
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  it harness.items;
  bad text;
  wanted integer;
  queued integer;
BEGIN
  SELECT k INTO bad FROM jsonb_object_keys(coalesce(p_patch, '{}'::jsonb)) k
   WHERE k NOT IN ('payload', 'sources', 'locales', 'revise_count', 'last_issues', 'question_id') LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'transition patch key not allowed: %', bad USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(coalesce(p_jobs, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'p_jobs must be an array' USING ERRCODE = '22023';
  END IF;

  UPDATE harness.items i
     SET stage = p_to_stage,
         version = i.version + 1,
         payload = coalesce(p_patch -> 'payload', i.payload),
         sources = coalesce(p_patch -> 'sources', i.sources),
         locales = coalesce(p_patch -> 'locales', i.locales),
         revise_count = coalesce((p_patch ->> 'revise_count')::integer, i.revise_count),
         last_issues = coalesce(p_patch -> 'last_issues', i.last_issues),
         question_id = coalesce((p_patch ->> 'question_id')::uuid, i.question_id),
         released_at = CASE WHEN (p_patch ->> 'question_id') IS NOT NULL THEN coalesce(i.released_at, now()) ELSE i.released_at END,
         updated_at = now()
   WHERE i.id = p_item AND i.stage = p_from_stage AND i.version = p_version
  RETURNING i.* INTO it;
  IF it.id IS NULL THEN RETURN; END IF;

  IF p_current_job IS NOT NULL THEN
    UPDATE harness.jobs SET status = 'done', finished_at = now(), lease_until = NULL
     WHERE id = p_current_job AND item_id = p_item AND status = 'running' AND lease_token = p_current_token;
    -- The job lost its lease (requeued, cancelled, or claimed again by another
    -- worker) before this result arrived: it no longer counts, so nothing moves.
    IF NOT FOUND THEN
      RAISE EXCEPTION 'job % is no longer running; its result is stale', p_current_job USING ERRCODE = '40001';
    END IF;
  END IF;
  UPDATE harness.jobs SET status = 'cancelled', finished_at = now(), error = 'superseded by a newer item version',
         lease_owner = NULL, lease_token = NULL, lease_until = NULL
   WHERE item_id = p_item AND status IN ('queued', 'running') AND item_version IS DISTINCT FROM it.version
     AND id IS DISTINCT FROM p_current_job;

  wanted := jsonb_array_length(coalesce(p_jobs, '[]'::jsonb));
  INSERT INTO harness.jobs (kind, agent_slug, item_id, item_version, priority, input)
  SELECT j ->> 'kind', j ->> 'agent_slug', p_item, it.version,
         coalesce((j ->> 'priority')::smallint, 2), coalesce(j -> 'input', '{}'::jsonb)
    FROM jsonb_array_elements(coalesce(p_jobs, '[]'::jsonb)) j;
  GET DIAGNOSTICS queued = ROW_COUNT;
  IF queued <> wanted THEN
    RAISE EXCEPTION 'transition queued % of % follow-up jobs', queued, wanted;
  END IF;

  INSERT INTO harness.events (type, message, item_id, data)
  VALUES ('item_stage', format('%s -> %s', p_from_stage, p_to_stage), p_item,
          jsonb_build_object('from', p_from_stage, 'to', p_to_stage, 'version', it.version));
  RETURN NEXT it;
END;
$$;

-- Creates an item and moves it to its first stage in one transaction, so a
-- failure can never leave a draft without its next job.
CREATE FUNCTION harness.create_item(p_item jsonb, p_to_stage text, p_patch jsonb DEFAULT '{}'::jsonb, p_jobs jsonb DEFAULT '[]'::jsonb)
RETURNS SETOF harness.items
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO harness.items (mode, contract_version, brief_id, category_id, difficulty, payload, sources)
  VALUES (p_item ->> 'mode', (p_item ->> 'contract_version')::integer, (p_item ->> 'brief_id')::uuid,
          (p_item ->> 'category_id')::uuid, p_item ->> 'difficulty', p_item -> 'payload', coalesce(p_item -> 'sources', '[]'::jsonb))
  RETURNING id INTO v_id;
  RETURN QUERY SELECT * FROM harness.transition(v_id, 'draft', 0, p_to_stage, p_patch, p_jobs);
END;
$$;

-- Creates a brief and its planning job in one transaction.
CREATE FUNCTION harness.create_brief(p_brief jsonb, p_plan_agent text, p_priority smallint DEFAULT 2)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO harness.briefs (mode, contract_version, category_id, difficulty, count, reason)
  VALUES (p_brief ->> 'mode', (p_brief ->> 'contract_version')::integer, (p_brief ->> 'category_id')::uuid,
          p_brief ->> 'difficulty', (p_brief ->> 'count')::integer, p_brief ->> 'reason')
  RETURNING id INTO v_id;
  INSERT INTO harness.jobs (kind, agent_slug, brief_id, priority) VALUES ('plan', p_plan_agent, v_id, p_priority);
  RETURN v_id;
END;
$$;

-- Merges usage-window readings into an account, newest reading per window
-- wins, under a row lock: concurrent runs cannot overwrite each other.
CREATE FUNCTION harness.record_windows(p_account text, p_windows jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  cur jsonb;
  k text;
  w jsonb;
BEGIN
  SELECT windows INTO cur FROM harness.accounts WHERE id = p_account FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  FOR k, w IN SELECT * FROM jsonb_each(coalesce(p_windows, '{}'::jsonb)) LOOP
    IF cur -> k IS NULL OR (w ->> 'seen_at')::timestamptz >= (cur -> k ->> 'seen_at')::timestamptz THEN
      cur := jsonb_set(coalesce(cur, '{}'::jsonb), ARRAY[k], w);
    END IF;
  END LOOP;
  UPDATE harness.accounts SET windows = cur, updated_at = now() WHERE id = p_account;
END;
$$;

-- Takes (or renews) a named lease for p_seconds. True when this owner holds it.
CREATE FUNCTION harness.try_trigger_lease(p_name text, p_owner text, p_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  got text;
BEGIN
  INSERT INTO harness.trigger_leases (name, owner, until)
  VALUES (p_name, p_owner, now() + make_interval(secs => p_seconds))
  ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner, until = EXCLUDED.until
   WHERE harness.trigger_leases.until < now() OR harness.trigger_leases.owner = EXCLUDED.owner
  RETURNING owner INTO got;
  RETURN coalesce(got = p_owner, false);
END;
$$;

-- ── Classic ranked health ──────────────────────────────────────────────────
-- Per category: Classic multiple-choice questions players actually saw in
-- ranked in the last 30 days, the live pool, items in the pipeline, and the
-- shortage against the view cap (needed = ceil(views / cap)). Pool and
-- pipeline are also given per difficulty so the difficulty mix can be kept.
-- An approved item whose question was published by hand is counted in the
-- pool only.
CREATE FUNCTION harness.classic_health(p_cap integer DEFAULT 100)
RETURNS TABLE (
  category_id uuid, slug text, views_30d bigint, pool bigint, in_pipeline bigint, needed bigint, shortage bigint,
  pool_easy bigint, pool_medium bigint, pool_hard bigint, pipe_easy bigint, pipe_medium bigint, pipe_hard bigint
)
LANGUAGE sql
STABLE
SET search_path = public, harness, pg_temp
AS $$
  WITH views AS (
    SELECT mq.category_id, count(*) AS v
      FROM public.match_questions mq
      JOIN public.matches m ON m.id = mq.match_id
      JOIN public.questions q ON q.id = mq.question_id
     WHERE m.mode = 'ranked' AND NOT coalesce(m.is_dev, false)
       AND q.type = 'mcq_single'
       AND mq.shown_at IS NOT NULL
       AND mq.shown_at > now() - interval '30 days'
     GROUP BY 1
  ), pool AS (
    SELECT q.category_id, count(*) AS n,
           count(*) FILTER (WHERE q.difficulty = 'easy') AS e,
           count(*) FILTER (WHERE q.difficulty = 'medium') AS m,
           count(*) FILTER (WHERE q.difficulty = 'hard') AS h
      FROM public.questions q
     WHERE q.status = 'published' AND q.visibility = 'public'
       AND q.ranked_eligible AND q.type = 'mcq_single'
     GROUP BY 1
  ), pipe AS (
    SELECT i.category_id, count(*) AS n,
           count(*) FILTER (WHERE i.difficulty = 'easy') AS e,
           count(*) FILTER (WHERE i.difficulty = 'medium') AS m,
           count(*) FILTER (WHERE i.difficulty = 'hard') AS h
      FROM harness.items i
      LEFT JOIN public.questions pq ON pq.id = i.question_id
     WHERE i.mode = 'classic'
       AND i.stage IN ('draft', 'validated', 'verified', 'localized', 'approved')
       AND (pq.id IS NULL OR pq.status <> 'published')
       -- released, then deleted by an editor: not on its way any more
       AND NOT (i.released_at IS NOT NULL AND i.question_id IS NULL)
     GROUP BY 1
  )
  SELECT c.id, c.slug, v.v, coalesce(p.n, 0), coalesce(x.n, 0),
         ceil(v.v::numeric / greatest(p_cap, 1))::bigint,
         greatest(ceil(v.v::numeric / greatest(p_cap, 1))::bigint - coalesce(p.n, 0) - coalesce(x.n, 0), 0),
         coalesce(p.e, 0), coalesce(p.m, 0), coalesce(p.h, 0), coalesce(x.e, 0), coalesce(x.m, 0), coalesce(x.h, 0)
    FROM views v
    JOIN public.categories c ON c.id = v.category_id AND c.is_active
    LEFT JOIN pool p ON p.category_id = v.category_id
    LEFT JOIN pipe x ON x.category_id = v.category_id
   ORDER BY 7 DESC, 3 DESC;
$$;

-- ── security ───────────────────────────────────────────────────────────────
ALTER TABLE harness.settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness.accounts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness.agents    ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness.contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness.policies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness.briefs    ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness.items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness.jobs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness.verdicts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness.runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness.events    ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness.daily_claims   ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness.trigger_leases ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON SCHEMA harness FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA harness FROM PUBLIC;
REVOKE ALL ON FUNCTION harness.claim_job(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION harness.finish_job(uuid, uuid, text, jsonb, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION harness.release_expired_leases() FROM PUBLIC;
REVOKE ALL ON FUNCTION harness.transition(uuid, text, integer, text, jsonb, jsonb, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION harness.job_gave_up(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION harness.create_item(jsonb, text, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION harness.create_brief(jsonb, text, smallint) FROM PUBLIC;
REVOKE ALL ON FUNCTION harness.record_windows(text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION harness.try_trigger_lease(text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION harness.classic_health(integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA harness FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA harness FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA harness TO service_role';
    EXECUTE 'GRANT ALL ON ALL TABLES IN SCHEMA harness TO service_role';
    EXECUTE 'GRANT ALL ON ALL SEQUENCES IN SCHEMA harness TO service_role';
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA harness TO service_role';
  END IF;
END $$;

-- ── seed: accounts ─────────────────────────────────────────────────────────
-- Agents get 4 premium seats, Ultra and Codex. The nika@quizball.io seat is
-- for people only and is registered here so it can never be routed to.
INSERT INTO harness.accounts (id, provider, label, secret_ref, status, reserved_for_people) VALUES
  ('claude-ultra',     'claude', 'Claude Ultra (Games builders, Making overflow)', 'HARNESS_CLAUDE_ULTRA_TOKEN', 'active', false),
  ('claude-premium-1', 'claude', 'Claude premium seat 1 (Making)', 'HARNESS_CLAUDE_PREMIUM_1_TOKEN', 'active', false),
  ('claude-premium-2', 'claude', 'Claude premium seat 2 (Localization, Question Writer)', 'HARNESS_CLAUDE_PREMIUM_2_TOKEN', 'active', false),
  ('claude-premium-3', 'claude', 'Claude premium seat 3 (Sensing, Suggesting, Foundation, Live)', 'HARNESS_CLAUDE_PREMIUM_3_TOKEN', 'active', false),
  ('claude-premium-4', 'claude', 'Claude premium seat 4 (Games design, spare)', 'HARNESS_CLAUDE_PREMIUM_4_TOKEN', 'active', false),
  ('codex-1',          'codex',  'Codex (all checkers)', 'HARNESS_CODEX_HOME_1', 'active', false),
  ('claude-people',    'claude', 'nika@quizball.io seat: people only', 'HARNESS_NEVER_USED', 'disabled', true);

-- ── seed: the first-slice agents ───────────────────────────────────────────
INSERT INTO harness.agents (slug, name, team, description, provider, model, effort, primary_account, fallback_accounts, max_turns) VALUES
  ('content-planner', 'Content Planner', 'suggesting',
   'Turns a pool shortage into angles for the makers: which subtopics to cover, which to avoid.',
   'claude', 'claude-sonnet-5-5', NULL, 'claude-premium-3', ARRAY['claude-premium-1'], 6),
  ('question-maker', 'Question Maker', 'making',
   'Writes multiple-choice questions for a brief, with sources for every fact.',
   'claude', 'claude-opus-5-5', NULL, 'claude-premium-1', ARRAY['claude-premium-2', 'claude-ultra'], 16),
  ('fact-checker', 'Fact Checker', 'checking',
   'Checks every claim and the answer key with its own sources. Never sees the maker''s reasoning.',
   'codex', 'gpt-6.1-sol', 'high', 'codex-1', '{}', 1),
  ('quality-judge', 'Quality Judge', 'checking',
   'Scores clarity, one correct answer, difficulty, fun and whether it can be searched within the time limit.',
   'codex', 'gpt-6.1-sol', 'medium', 'codex-1', '{}', 1),
  ('localizer', 'Localizer', 'localization',
   'Writes the question in all 9 languages, using local spellings of names.',
   'claude', 'claude-sonnet-5-5', NULL, 'claude-premium-2', ARRAY['claude-premium-1'], 4),
  ('locale-checker', 'Locale Checker', 'checking',
   'Checks each language version against the English original: meaning, names, natural phrasing.',
   'codex', 'gpt-6.1-sol', 'medium', 'codex-1', '{}', 1);

-- ── seed: Classic contract v1 and policies ─────────────────────────────────
INSERT INTO harness.contracts (mode, version, body) VALUES
  ('classic', 1, $c${
    "name": "Classic ranked",
    "family": "questions",
    "question_type": "mcq_single",
    "options": 4,
    "correct_options": 1,
    "max_stem_chars": 130,
    "max_option_chars": 60,
    "locales": ["en", "ka", "es", "tr", "ru", "pt", "de", "fr", "el"],
    "ranked": {"view_cap_30d": 100, "difficulty_mix": {"easy": 0.4, "medium": 0.4, "hard": 0.2}},
    "sources_per_fact": 2,
    "max_revisions": 2,
    "rubric": ["one clearly correct answer", "plausible wrong options", "clear wording", "difficulty matches the label", "not searchable within the time limit", "fun for football fans"]
  }$c$::jsonb);

INSERT INTO harness.policies (key, value, note) VALUES
  ('classic.release_status', '"draft"', 'draft = released items wait in the CMS draft queue; published = straight into the ranked pool'),
  ('classic.brief_size', '10', 'questions per brief'),
  ('classic.max_open_briefs_per_category', '2', 'cap on parallel work per category'),
  ('classic.max_new_briefs_per_tick', '6', 'cap on briefs created per health check'),
  ('classic.min_quality_score', '7', 'Quality Judge score (0-10) needed to pass');
