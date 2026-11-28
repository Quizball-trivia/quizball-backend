-- Feedback (HQ, straight to prod): what players tell us, in one place.
--   feedback        one thing a player wrote: the contact form (it used to be an email and nothing else), a Season 3
--                   idea, or a comment left after a game. Georgian is shown as it is; anything else that is not
--                   English gets an English translation next to the original.
--   feedback_reads  one round of the Feedback Reader: it translates what is new and writes a recap of everything
--                   recent. The newest finished round is the recap on the page.
-- The reader gets the words only: never a player's name or email. It changes nothing in the game.

-- Georgian when at least half of the letters are Georgian script, in any of its alphabets: the everyday one, its
-- capitals (Mtavruli) and the two old church ones. Georgian typed in Latin letters is left to the reader.
CREATE OR REPLACE FUNCTION harness.is_georgian(p_text text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT length(regexp_replace(coalesce(p_text, ''), '[^ა-ჿᲐ-ᲿႠ-Ⴭⴀ-ⴭ]', '', 'g')) > 0
     AND length(regexp_replace(coalesce(p_text, ''), '[^ა-ჿᲐ-ᲿႠ-Ⴭⴀ-ⴭ]', '', 'g')) * 2
         >= length(regexp_replace(coalesce(p_text, ''), '[^[:alpha:]]', '', 'g'));
$$;

CREATE SEQUENCE harness.feedback_number;

CREATE TABLE harness.feedback (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number       integer NOT NULL UNIQUE DEFAULT nextval('harness.feedback_number'),
  -- form: the contact form · season3: an idea from the Season 3 survey · game: a comment left after a game
  source       text NOT NULL CHECK (source IN ('form', 'season3', 'game')),
  -- What makes it the same feedback when it arrives twice: a hash of who and what (form), or the row it came from.
  source_ref   text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 200),
  category     text NOT NULL CHECK (category IN ('bug', 'feedback', 'other', 'idea', 'rating')),
  message      text NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  nickname     text CHECK (nickname IS NULL OR length(nickname) <= 120),
  email        text CHECK (email IS NULL OR length(email) <= 254),
  user_id      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  context      text CHECK (context IS NULL OR length(context) <= 500),
  attachments  text[] NOT NULL DEFAULT '{}',
  game         text,
  rating       smallint CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  -- The language the player's game was in, when we know it. Not the language they wrote in.
  locale       text,
  -- The language it is written in: 'ka', 'en', another code, or 'unknown'. NULL = not read yet.
  language     text CHECK (language IS NULL OR length(language) BETWEEN 2 AND 12),
  -- English, for anything that is neither Georgian nor English.
  english      text CHECK (english IS NULL OR length(english) <= 6000),
  -- When the player sent it (an email brought in later keeps the day it was sent): what the page sorts and shows by.
  received_at  timestamptz NOT NULL DEFAULT now(),
  -- When this text reached HQ: set when the row is written and again when its message changes. A recap knows what
  -- it has seen by this, so an old email brought in today is still new to it.
  arrived_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_ref)
);
ALTER TABLE harness.feedback ENABLE ROW LEVEL SECURITY;
CREATE INDEX harness_feedback_recent ON harness.feedback (received_at DESC);
CREATE INDEX harness_feedback_unread ON harness.feedback (received_at) WHERE language IS NULL;

-- Georgian needs no reader. A message that changes (a player rewrote a game comment) is read again.
CREATE OR REPLACE FUNCTION harness.feedback_language()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.message IS DISTINCT FROM OLD.message THEN
    IF harness.is_georgian(NEW.message) THEN
      NEW.language := 'ka';
    ELSE
      NEW.language := NULL;
    END IF;
    NEW.english := NULL;
    NEW.arrived_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER harness_feedback_language BEFORE INSERT OR UPDATE OF message ON harness.feedback
  FOR EACH ROW EXECUTE FUNCTION harness.feedback_language();

CREATE SEQUENCE harness.feedback_read_number;

CREATE TABLE harness.feedback_reads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        integer NOT NULL UNIQUE DEFAULT nextval('harness.feedback_read_number'),
  -- writing: the reader is working · ready · failed
  status        text NOT NULL DEFAULT 'writing' CHECK (status IN ('writing', 'ready', 'failed')),
  -- {summary, themes: [{title, count, points: []}], praise: [], urgent: []}
  recap         jsonb,
  -- How many pieces of feedback the recap was written from, and how many of them the round translated.
  items         integer NOT NULL DEFAULT 0,
  translated    integer NOT NULL DEFAULT 0,
  -- The latest arrival (feedback.arrived_at) there was when the round started: anything that arrived later is not
  -- in the recap yet. Written by the database from the rows themselves, to the microsecond.
  newest_at     timestamptz,
  -- A person's name, or 'schedule' when new feedback started it.
  requested_by  text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE harness.feedback_reads ENABLE ROW LEVEL SECURITY;
CREATE INDEX harness_feedback_reads_recent ON harness.feedback_reads (created_at DESC);
-- One round at a time: asking twice does not queue two.
CREATE UNIQUE INDEX harness_feedback_reads_one_writing ON harness.feedback_reads ((true)) WHERE status = 'writing';

-- Jobs can now read the feedback.
ALTER TABLE harness.jobs ADD COLUMN feedback_read_id uuid REFERENCES harness.feedback_reads(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX harness_jobs_one_live_per_feedback_read ON harness.jobs (feedback_read_id)
  WHERE feedback_read_id IS NOT NULL AND status IN ('queued', 'running');
ALTER TABLE harness.jobs DROP CONSTRAINT IF EXISTS harness_jobs_kind;
ALTER TABLE harness.jobs DROP CONSTRAINT IF EXISTS harness_jobs_target;
ALTER TABLE harness.jobs
  ADD CONSTRAINT harness_jobs_kind CHECK (kind IN ('plan', 'make', 'fact_check', 'quality_judge', 'localize', 'locale_check', 'ask', 'show_check', 'game_plan', 'report', 'idea_plan', 'idea_scout', 'feedback_read')),
  ADD CONSTRAINT harness_jobs_target CHECK (item_id IS NOT NULL OR brief_id IS NOT NULL OR ask_id IS NOT NULL OR show_pack_id IS NOT NULL OR game_change_id IS NOT NULL OR report_id IS NOT NULL OR idea_id IS NOT NULL OR feedback_read_id IS NOT NULL OR kind = 'idea_scout');

-- Saves a round, but only from the job that still holds its lease on a round still being written.
-- p_items: [{id, language, english}] for the feedback the job was given to read (job.input.toRead); a piece it was
-- not given, or one that was read or rewritten meanwhile, is left alone.
CREATE OR REPLACE FUNCTION harness.feedback_read_done(p_job uuid, p_token uuid, p_items jsonb, p_recap jsonb)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  j harness.jobs;
  n integer := 0;
BEGIN
  SELECT * INTO j FROM harness.jobs WHERE id = p_job AND status = 'running' AND lease_token = p_token FOR UPDATE;
  IF NOT FOUND OR j.feedback_read_id IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM harness.feedback_reads WHERE id = j.feedback_read_id AND status = 'writing' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF jsonb_typeof(p_items) = 'array' THEN
    UPDATE harness.feedback f
       SET language = x.language, english = x.english, updated_at = now()
      FROM (
        SELECT DISTINCT ON (e->>'id') e->>'id' AS id,
               left(lower(btrim(e->>'language')), 12) AS language,
               nullif(left(btrim(coalesce(e->>'english', '')), 6000), '') AS english
          FROM jsonb_array_elements(p_items) AS e
         WHERE e->>'id' ~ '^[0-9a-f-]{36}$' AND length(btrim(coalesce(e->>'language', ''))) BETWEEN 2 AND 12
      ) AS x
      JOIN jsonb_array_elements(CASE WHEN jsonb_typeof(j.input->'toRead') = 'array' THEN j.input->'toRead' ELSE '[]'::jsonb END) AS given
        ON given->>'id' = x.id
     WHERE f.id = x.id::uuid AND f.language IS NULL
       -- Read as it was given: a comment rewritten since is read again next round.
       AND md5(f.message) = given->>'hash';
    -- How many of them were given an English translation (a message found to be English or Georgian gets none).
    SELECT count(*) INTO n
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(j.input->'toRead') = 'array' THEN j.input->'toRead' ELSE '[]'::jsonb END) AS given
      JOIN harness.feedback f ON f.id::text = given->>'id'
     WHERE f.english IS NOT NULL AND f.language NOT IN ('ka', 'en');
  END IF;
  UPDATE harness.feedback_reads
     SET status = 'ready', recap = p_recap, translated = n, error = NULL, updated_at = now()
   WHERE id = j.feedback_read_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION harness.feedback_read_done(uuid, uuid, jsonb, jsonb) FROM PUBLIC;

-- A feedback job that gives up marks its round failed, so nobody waits on it.
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

-- The Feedback Reader: reads what players wrote, translates what is not Georgian or English, and writes the recap.
-- It has no tools: it cannot search, open a page or change anything.
INSERT INTO harness.agents (slug, name, team, description, provider, model, effort, primary_account, fallback_accounts, max_turns, timeout_ms)
VALUES ('feedback-reader', 'Feedback Reader', 'suggesting',
        'Reads what players write to us, puts anything that is not Georgian or English into English, and writes a short recap of what players are asking for.',
        'claude', 'claude-opus-5-5', NULL, 'claude-premium-2',
        ARRAY['claude-premium-1', 'claude-premium-5', 'claude-premium-4', 'claude-premium-3', 'claude-ultra'], 8, 480000)
ON CONFLICT (slug) DO NOTHING;

-- What players already told us in the game: the Season 3 ideas and the comments left after a game.
INSERT INTO harness.feedback (source, source_ref, category, message, nickname, user_id, locale, received_at)
SELECT 'season3', r.id::text, 'idea', left(btrim(r.idea), 4000), left(u.nickname, 120), r.user_id, r.locale, r.created_at
  FROM public.season3_survey_responses r
  LEFT JOIN public.users u ON u.id = r.user_id
 WHERE r.kind = 'idea' AND length(btrim(coalesce(r.idea, ''))) > 0
ON CONFLICT (source, source_ref) DO NOTHING;

INSERT INTO harness.feedback (source, source_ref, category, message, nickname, user_id, game, rating, locale, received_at)
SELECT 'game', g.id::text, 'rating', left(btrim(g.comment), 4000), left(u.nickname, 120), g.user_id, g.game, g.rating, g.locale, g.updated_at
  FROM public.game_feedback g
  LEFT JOIN public.users u ON u.id = g.user_id
 WHERE length(btrim(coalesce(g.comment, ''))) > 0
ON CONFLICT (source, source_ref) DO NOTHING;

-- If this migration was rolled back earlier, the rollback kept the contact-form messages (they exist nowhere else
-- once their email is gone): put them back. The other two kinds were copied in again above.
DO $$
BEGIN
  IF to_regclass('harness.feedback_kept') IS NOT NULL THEN
    INSERT INTO harness.feedback (source, source_ref, category, message, nickname, email, user_id, context, attachments, locale, received_at)
    SELECT k.source, k.source_ref, k.category, k.message, k.nickname, k.email, (SELECT u.id FROM public.users u WHERE u.id = k.user_id),
           k.context, k.attachments, k.locale, k.received_at
      FROM harness.feedback_kept k WHERE k.source = 'form'
    ON CONFLICT (source, source_ref) DO NOTHING;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON harness.feedback, harness.feedback_reads TO service_role';
    EXECUTE 'GRANT USAGE ON SEQUENCE harness.feedback_number, harness.feedback_read_number TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.job_gave_up(uuid, text) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.feedback_read_done(uuid, uuid, jsonb, jsonb) TO service_role';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
