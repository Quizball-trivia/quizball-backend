-- Show packs in the hub (HQ, straight to prod).
--   show_packs   the weekly ორშაბათობა pack, prepared ahead of each show Monday:
--                the backend builds it from the public question bank, the Show
--                Checker agent verifies every question, a person approves it,
--                and approving loads it into wl_show_packs (what the show plays).
--   Unlike the rest of the hub a person approves here: the hosts read these
--   questions out live, and a wrong one cannot be fixed quietly afterwards.

CREATE TABLE harness.show_packs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL DEFAULT 'orshabatoba' CHECK (slug = 'orshabatoba'),
  event_date   date NOT NULL CHECK (extract(isodow FROM event_date) = 1),
  -- checking: jobs are verifying questions · flagged: the backend swaps the
  -- flagged ones · ready: waiting for a person · approved: loaded for the show
  status       text NOT NULL DEFAULT 'checking' CHECK (status IN ('checking', 'flagged', 'ready', 'approved')),
  -- The pack exactly as wl_show_packs takes it (answer keys included).
  pack         jsonb NOT NULL,
  -- One entry per question, in play order:
  -- {round, question, kind, source_id, check: unchecked|ok|flagged|skipped, note, view}
  questions    jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(questions) = 'array'),
  -- How many times flagged questions were swapped automatically.
  swap_rounds  integer NOT NULL DEFAULT 0,
  approved_by  text,
  loaded_hash  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug, event_date)
);
ALTER TABLE harness.show_packs ENABLE ROW LEVEL SECURITY;

-- Jobs can now check questions of a show pack (input.indexes = which ones).
ALTER TABLE harness.jobs ADD COLUMN show_pack_id uuid REFERENCES harness.show_packs(id) ON DELETE CASCADE;
CREATE INDEX harness_jobs_show_pack ON harness.jobs (show_pack_id) WHERE show_pack_id IS NOT NULL;
ALTER TABLE harness.jobs DROP CONSTRAINT IF EXISTS harness_jobs_kind;
ALTER TABLE harness.jobs DROP CONSTRAINT IF EXISTS harness_jobs_target;
ALTER TABLE harness.jobs
  ADD CONSTRAINT harness_jobs_kind CHECK (kind IN ('plan', 'make', 'fact_check', 'quality_judge', 'localize', 'locale_check', 'ask', 'show_check')),
  ADD CONSTRAINT harness_jobs_target CHECK (item_id IS NOT NULL OR brief_id IS NOT NULL OR ask_id IS NOT NULL OR show_pack_id IS NOT NULL);

-- Records check results for some questions of a pack and moves the pack on
-- once none is left unchecked. A result only lands on the question it was
-- made for (same position, same source question, still unchecked), so a
-- result that arrives after a swap is dropped.
CREATE OR REPLACE FUNCTION harness.show_pack_checked(p_pack uuid, p_results jsonb)
RETURNS text
LANGUAGE plpgsql
SET search_path = harness, pg_temp
AS $$
DECLARE
  sp   harness.show_packs;
  qs   jsonb;
  r    jsonb;
  i    integer;
  next text;
BEGIN
  SELECT * INTO sp FROM harness.show_packs WHERE id = p_pack FOR UPDATE;
  IF NOT FOUND THEN RETURN 'missing'; END IF;
  IF sp.status <> 'checking' THEN RETURN sp.status; END IF;
  qs := sp.questions;
  FOR r IN SELECT * FROM jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) LOOP
    CONTINUE WHEN jsonb_typeof(r->'i') IS DISTINCT FROM 'number';
    i := (r->>'i')::integer;
    IF i >= 0 AND i < jsonb_array_length(qs)
       AND qs->i->>'source_id' = r->>'source_id'
       AND qs->i->>'check' = 'unchecked'
       AND r->>'check' IN ('ok', 'flagged', 'skipped') THEN
      qs := jsonb_set(qs, ARRAY[i::text], (qs->i) || jsonb_build_object('check', r->>'check', 'note', left(coalesce(r->>'note', ''), 500)));
    END IF;
  END LOOP;
  next := CASE
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(qs) q WHERE q->>'check' = 'unchecked') THEN 'checking'
    WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(qs) q WHERE q->>'check' = 'flagged') THEN 'flagged'
    ELSE 'ready'
  END;
  UPDATE harness.show_packs SET questions = qs, status = next, updated_at = now() WHERE id = p_pack;
  RETURN next;
END;
$$;
REVOKE ALL ON FUNCTION harness.show_pack_checked(uuid, jsonb) FROM PUBLIC;

-- A check job that gives up marks its questions "skipped" (not checked), so
-- the pack still reaches a person instead of waiting forever.
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
               'i', (e.ord - 1)::integer, 'source_id', e.q->>'source_id', 'check', 'skipped',
               'note', 'The checker could not run: ' || left(coalesce(p_reason, 'failed'), 200))), '[]'::jsonb)
        FROM harness.show_packs sp, jsonb_array_elements(sp.questions) WITH ORDINALITY AS e(q, ord)
       WHERE sp.id = j.show_pack_id
         AND jsonb_typeof(j.input->'indexes') = 'array'
         AND (j.input->'indexes') @> to_jsonb((e.ord - 1)::integer)));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION harness.job_gave_up(uuid, text) FROM PUBLIC;

-- The Show Checker: a different AI from the ones that wrote the bank. It
-- checks each question as the hosts will read it: is the answer right and
-- still true today, and does the Georgian read well out loud.
INSERT INTO harness.agents (slug, name, team, description, provider, model, effort, primary_account, fallback_accounts, max_turns, timeout_ms)
VALUES ('show-checker', 'Show Checker', 'checking',
        'Checks every question of the weekly ორშაბათობა show pack: the answer, whether it is still true today, and the Georgian the hosts read out.',
        'codex', 'gpt-6.1-sol', 'high', 'codex-1', '{}', 1, 540000)
ON CONFLICT (slug) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT ALL ON harness.show_packs TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.show_pack_checked(uuid, jsonb) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION harness.job_gave_up(uuid, text) TO service_role';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
