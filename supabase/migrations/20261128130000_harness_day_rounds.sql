-- Day Builder (HQ, straight to prod): agents write the next days of a daily game before its calendar runs out.
-- First game: Football Clues (pistas). A day there is ten rounds; a round is one footballer told in ten clues.
--
--   day_rounds   one round on its way to a day:
--                planned    the Day Builder named the footballer
--                written    it researched and wrote the clues (English), with the pages it used
--                checked    the Fact Checker (another model family) confirmed every clue against the web,
--                           corrected what was slightly off and removed what it could not confirm
--                ready      the Localizer wrote the clues and the name in every language
--                used       the round is in a stored day (used_on)
--                dropped    it failed somewhere; nothing a player sees comes from a dropped round
--
-- Nobody approves a round: a clue the checker cannot confirm is removed, and a round left with too few clues is
-- dropped. The backend puts ready rounds together into the next day and stores it with the game's own checks
-- (the same code the seed script runs), so a day that would not pass them is never stored.

CREATE SEQUENCE harness.day_round_number;

CREATE TABLE harness.day_rounds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number       integer NOT NULL UNIQUE DEFAULT nextval('harness.day_round_number'),
  game         text NOT NULL CHECK (game IN ('pistas')),
  status       text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'written', 'checked', 'ready', 'used', 'dropped')),
  difficulty   text NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  -- Who the round is about, as the Day Builder named them, and the same name reduced to letters and digits:
  -- a footballer is planned once per game, ever.
  subject      text NOT NULL CHECK (length(subject) BETWEEN 2 AND 120),
  subject_key  text NOT NULL CHECK (subject_key ~ '^[a-z0-9]{2,120}$'),
  -- One line that says which person is meant (two footballers can share a name).
  hint         text NOT NULL DEFAULT '' CHECK (length(hint) <= 300),
  -- What the writer returned (English): profile, clues, names, the pages behind each clue.
  draft        jsonb,
  -- What stands after the fact check (English), in the same shape.
  checked      jsonb,
  -- The clues and the name in every language.
  localized    jsonb,
  -- Why it was dropped, or what the checker changed.
  note         text CHECK (note IS NULL OR length(note) <= 1000),
  used_on      date,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game, subject_key),
  CONSTRAINT harness_day_rounds_used CHECK ((status = 'used') = (used_on IS NOT NULL))
);
ALTER TABLE harness.day_rounds ENABLE ROW LEVEL SECURITY;
CREATE INDEX harness_day_rounds_open ON harness.day_rounds (game, status, difficulty) WHERE status NOT IN ('used', 'dropped');

-- Jobs: naming footballers (round_plan, for a game, no single target), then one job per round and step.
ALTER TABLE harness.jobs ADD COLUMN day_round_id uuid REFERENCES harness.day_rounds(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX harness_jobs_one_live_per_day_round ON harness.jobs (day_round_id, kind)
  WHERE day_round_id IS NOT NULL AND status IN ('queued', 'running');
-- One planning round per game at a time.
CREATE UNIQUE INDEX harness_jobs_one_live_round_plan ON harness.jobs ((input->>'game'))
  WHERE kind = 'round_plan' AND status IN ('queued', 'running');
ALTER TABLE harness.jobs DROP CONSTRAINT IF EXISTS harness_jobs_kind;
ALTER TABLE harness.jobs DROP CONSTRAINT IF EXISTS harness_jobs_target;
ALTER TABLE harness.jobs
  ADD CONSTRAINT harness_jobs_kind CHECK (kind IN ('plan', 'make', 'fact_check', 'quality_judge', 'localize', 'locale_check', 'ask', 'show_check', 'game_plan', 'report', 'idea_plan', 'idea_scout', 'feedback_read', 'round_plan', 'round_write', 'round_check', 'round_localize')),
  ADD CONSTRAINT harness_jobs_target CHECK (item_id IS NOT NULL OR brief_id IS NOT NULL OR ask_id IS NOT NULL OR show_pack_id IS NOT NULL OR game_change_id IS NOT NULL OR report_id IS NOT NULL OR idea_id IS NOT NULL OR feedback_read_id IS NOT NULL OR day_round_id IS NOT NULL OR kind IN ('idea_scout', 'round_plan'));

-- Saves the footballers a planning job named and queues the writing of each, once, under the job's lease.
-- p_rounds: [{subject, subject_key, difficulty, hint}]. A footballer already planned for the game is skipped.
CREATE OR REPLACE FUNCTION harness.rounds_planned(p_job uuid, p_token uuid, p_rounds jsonb, p_writer text)
RETURNS integer
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  j harness.jobs;
  r record;
  new_id uuid;
  n integer := 0;
BEGIN
  SELECT * INTO j FROM harness.jobs WHERE id = p_job AND status = 'running' AND lease_token = p_token FOR UPDATE;
  IF NOT FOUND OR j.kind <> 'round_plan' OR jsonb_typeof(p_rounds) <> 'array' THEN RETURN 0; END IF;
  FOR r IN
    SELECT DISTINCT ON (x->>'subject_key')
           left(btrim(x->>'subject'), 120) AS subject, x->>'subject_key' AS subject_key, x->>'difficulty' AS difficulty,
           left(btrim(coalesce(x->>'hint', '')), 300) AS hint
      FROM jsonb_array_elements(p_rounds) AS x
     WHERE x->>'subject_key' ~ '^[a-z0-9]{2,120}$' AND length(btrim(coalesce(x->>'subject', ''))) >= 2
       AND x->>'difficulty' IN ('easy', 'medium', 'hard')
     LIMIT 60
  LOOP
    INSERT INTO harness.day_rounds (game, difficulty, subject, subject_key, hint)
    VALUES (j.input->>'game', r.difficulty, r.subject, r.subject_key, r.hint)
    -- A round that was dropped only because a job gave up (an outage, not a verdict on the footballer) may be
    -- planned again; any other earlier round keeps the footballer taken.
    ON CONFLICT (game, subject_key) DO UPDATE
      SET status = 'planned', difficulty = EXCLUDED.difficulty, subject = EXCLUDED.subject, hint = EXCLUDED.hint,
          draft = NULL, checked = NULL, localized = NULL, note = NULL, updated_at = now()
      WHERE harness.day_rounds.status = 'dropped' AND harness.day_rounds.note LIKE '% gave up: %'
    RETURNING id INTO new_id;
    -- No row came back: the footballer is taken. new_id must not keep the last loop's value.
    IF NOT FOUND THEN new_id := NULL; END IF;
    IF new_id IS NOT NULL THEN
      INSERT INTO harness.jobs (kind, agent_slug, day_round_id, priority) VALUES ('round_write', p_writer, new_id, 3);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION harness.rounds_planned(uuid, uuid, jsonb, text) FROM PUBLIC;

-- Moves a round one step on and queues the next job, under the lease of the job that did the step.
--   round_write    planned → written  (p_body = the draft)             next: round_check
--   round_check    written → checked  (p_body = what stands)           next: round_localize
--   round_localize checked → ready    (p_body = every language)        next: none
-- p_drop: the round is dropped instead, with p_note as the reason.
CREATE OR REPLACE FUNCTION harness.round_step_done(p_job uuid, p_token uuid, p_body jsonb, p_note text, p_drop boolean, p_next_agent text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  j harness.jobs;
  was text;
  becomes text;
  next_kind text;
BEGIN
  SELECT * INTO j FROM harness.jobs WHERE id = p_job AND status = 'running' AND lease_token = p_token FOR UPDATE;
  IF NOT FOUND OR j.day_round_id IS NULL THEN RETURN false; END IF;
  IF j.kind = 'round_write' THEN was := 'planned'; becomes := 'written'; next_kind := 'round_check';
  ELSIF j.kind = 'round_check' THEN was := 'written'; becomes := 'checked'; next_kind := 'round_localize';
  ELSIF j.kind = 'round_localize' THEN was := 'checked'; becomes := 'ready'; next_kind := NULL;
  ELSE RETURN false;
  END IF;
  IF p_drop THEN
    UPDATE harness.day_rounds SET status = 'dropped', note = left(coalesce(p_note, 'dropped'), 1000), updated_at = now()
     WHERE id = j.day_round_id AND status = was;
    RETURN FOUND;
  END IF;
  IF jsonb_typeof(p_body) <> 'object' THEN RETURN false; END IF;
  UPDATE harness.day_rounds
     -- A step with nothing to say keeps what the step before it noted (what the checker changed).
     SET status = becomes, updated_at = now(), note = coalesce(nullif(left(coalesce(p_note, ''), 1000), ''), note),
         draft = CASE WHEN j.kind = 'round_write' THEN p_body ELSE draft END,
         checked = CASE WHEN j.kind = 'round_check' THEN p_body ELSE checked END,
         localized = CASE WHEN j.kind = 'round_localize' THEN p_body ELSE localized END
   WHERE id = j.day_round_id AND status = was;
  IF NOT FOUND THEN RETURN false; END IF;
  IF next_kind IS NOT NULL AND p_next_agent IS NOT NULL THEN
    INSERT INTO harness.jobs (kind, agent_slug, day_round_id, priority) VALUES (next_kind, p_next_agent, j.day_round_id, 3);
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION harness.round_step_done(uuid, uuid, jsonb, text, boolean, text) FROM PUBLIC;

-- A job that gives up on a round drops the round, so the pipeline never waits on it.
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
  ELSIF j.day_round_id IS NOT NULL THEN
    -- Only a round still waiting for this job's step. A job whose step was saved and whose worker then died is
    -- "given up" later, when its lease runs out: by then the round has moved on, and it is left alone.
    UPDATE harness.day_rounds SET status = 'dropped', note = left(j.kind || ' gave up: ' || coalesce(p_reason, 'failed'), 1000), updated_at = now()
     WHERE id = j.day_round_id
       AND status = CASE j.kind WHEN 'round_write' THEN 'planned' WHEN 'round_check' THEN 'written' WHEN 'round_localize' THEN 'checked' END;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION harness.job_gave_up(uuid, text) FROM PUBLIC;

-- The Day Builder: names the footballers and writes their clues. It reads the public web and writes; it stores
-- nothing itself.
INSERT INTO harness.agents (slug, name, team, description, provider, model, effort, primary_account, fallback_accounts, max_turns, timeout_ms)
VALUES ('day-builder', 'Day Builder', 'making',
        'Builds the next days of the daily games before their calendars run out. For Football Clues it picks footballers nobody has had yet and writes their ten clues, each with the page it comes from.',
        'claude', 'claude-opus-5-5', NULL, 'claude-premium-1',
        ARRAY['claude-premium-2', 'claude-premium-5', 'claude-premium-4', 'claude-premium-3', 'claude-ultra'], 40, 540000)
ON CONFLICT (slug) DO NOTHING;

-- How far ahead of today each daily game should be stored, and how many rounds may be on their way at once.
INSERT INTO harness.policies (key, value, note) VALUES
  ('days.pistas.ahead', '21'::jsonb, 'Football Clues: how many days after today should already be stored. The Day Builder works until this many are.'),
  ('days.pistas.max_open_rounds', '60'::jsonb, 'Football Clues: the most rounds that may be on their way (planned to ready) at one time.'),
  -- Starts off: the first rounds are read by a person before any day is stored from them. While it is off the
  -- agents still write, check and translate rounds; they wait as "ready".
  ('days.pistas.store', 'false'::jsonb, 'Football Clues: whether finished rounds are put together into days and stored for players. Off = rounds are made and wait.')
ON CONFLICT (key) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON harness.day_rounds TO service_role';
    EXECUTE 'GRANT USAGE ON SEQUENCE harness.day_round_number TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.job_gave_up(uuid, text) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.rounds_planned(uuid, uuid, jsonb, text) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.round_step_done(uuid, uuid, jsonb, text, boolean, text) TO service_role';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
