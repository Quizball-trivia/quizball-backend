-- Content Fixer, unstuck (owner 2026-11-13: "we need the fixer to work on every game").
--
-- 1. Backoff. A gap given back without an outcome (claim returned unused, a lease that expired, a fix the verifier
--    disagreed with) counts one attempt and waits 6 h, 1 d, then 3 d before it can be claimed again. A fourth goes to
--    Romero (held, when players keep typing it: count >= 10) or is closed wontfix. One trigger owns that transition,
--    so every path back to open follows it. Until now the same unsolvable top gaps were re-claimed every run.
-- 2. Claim by name. A claim takes the most-typed NAMES (game + typed text, summed over boards) and every open gap of
--    each name, so one piece of research serves all the boards it was typed on. Decisions stay per board.
-- 3. Romero triages what is held (fixes and gaps). He can send a fix back to the verifier, reject it, or reopen its
--    gaps; he can reopen or close a held gap. He can never mark a fix verified: only the Content Verifier can.
-- 4. Fixer and Verifier run every hour.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.content_gaps ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE public.content_gaps ADD COLUMN IF NOT EXISTS next_try_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_content_gaps_open_name ON public.content_gaps (game, norm) WHERE status = 'open';

CREATE OR REPLACE FUNCTION public.content_gaps_backoff()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  NEW.attempts := OLD.attempts + 1;
  NEW.lease_owner := NULL;
  NEW.lease_token := NULL;
  NEW.lease_until := NULL;
  IF NEW.attempts >= 4 THEN
    NEW.status := CASE WHEN NEW.count >= 10 THEN 'held' ELSE 'wontfix' END;
    NEW.next_try_at := NULL;
    NEW.audit := NEW.audit || jsonb_build_array(jsonb_build_object(
      'at', now(), 'actor', 'system', 'from', OLD.status, 'to', NEW.status, 'reason', 'unresolved after 4 tries'));
  ELSE
    NEW.next_try_at := now() + (ARRAY[interval '6 hours', interval '1 day', interval '3 days'])[NEW.attempts];
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.content_gaps_backoff() FROM PUBLIC;

DROP TRIGGER IF EXISTS content_gaps_backoff ON public.content_gaps;
CREATE TRIGGER content_gaps_backoff
  BEFORE UPDATE OF status ON public.content_gaps
  FOR EACH ROW
  WHEN (NEW.status = 'open' AND OLD.status IN ('checking', 'proposed'))
  EXECUTE FUNCTION public.content_gaps_backoff();

-- Gaps the old claim kept re-taking (two revisions per claim and give-back) start with the tries they already had.
UPDATE public.content_gaps
   SET attempts = least(revision / 2, 3),
       next_try_at = CASE WHEN revision / 2 >= 3 THEN now() + interval '1 day' END
 WHERE status = 'open' AND revision >= 2 AND attempts = 0;

CREATE OR REPLACE FUNCTION hq.content_gaps_claim(p_owner text, p_limit integer DEFAULT 10, p_lease_minutes integer DEFAULT 60, p_game text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  token uuid := gen_random_uuid();
  out jsonb;
BEGIN
  IF coalesce(btrim(p_owner), '') = '' OR length(p_owner) > 120 THEN RAISE EXCEPTION 'owner required'; END IF;
  p_limit := least(greatest(coalesce(p_limit, 10), 1), 40);
  p_lease_minutes := least(greatest(coalesce(p_lease_minutes, 60), 5), 240);
  -- Leases a run never gave back (it crashed): back to open, which counts the attempt (trigger).
  UPDATE content_gaps g SET status = 'open', revision = g.revision + 1, updated_at = now()
   WHERE g.id IN (SELECT id FROM content_gaps WHERE status = 'checking' AND lease_until < now() ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED);
  WITH ready AS (
    SELECT g.id, g.game, g.norm, g.count FROM content_gaps g
    WHERE g.status = 'open' AND (g.next_try_at IS NULL OR g.next_try_at <= now()) AND (p_game IS NULL OR g.game = p_game)
  ), names AS (
    SELECT game, norm, sum(count) AS typed, row_number() OVER (ORDER BY sum(count) DESC, game, norm) AS rk
    FROM ready GROUP BY game, norm
    ORDER BY typed DESC, game, norm
    LIMIT p_limit
  ), ranked AS (
    SELECT r.id, n.rk, row_number() OVER (PARTITION BY r.game, r.norm ORDER BY r.count DESC, r.id) AS rn
    FROM ready r JOIN names n ON n.game = r.game AND n.norm = r.norm
  ), wanted AS (
    SELECT id FROM ranked WHERE rn <= 25 ORDER BY rk, rn LIMIT p_limit
  ), picked AS (
    SELECT g.id FROM content_gaps g
    WHERE g.id IN (SELECT id FROM wanted) AND g.status = 'open' AND (g.next_try_at IS NULL OR g.next_try_at <= now())
    ORDER BY g.id
    FOR UPDATE SKIP LOCKED
  ), leased AS (
    UPDATE content_gaps g SET status = 'checking', lease_owner = p_owner, lease_token = token,
           lease_until = now() + make_interval(mins => p_lease_minutes), revision = g.revision + 1, updated_at = now()
    FROM picked WHERE g.id = picked.id
    RETURNING g.*
  )
  SELECT jsonb_build_object(
    'token', token,
    'leaseUntil', (SELECT max(lease_until) FROM leased),
    'gaps', coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id, 'game', l.game, 'mode', l.mode, 'board', l.board_key, 'verdict', l.verdict, 'count', l.count,
      -- The name this gap belongs to and how often it was typed over all its boards: research it once.
      'name', l.norm, 'nameTyped', l.name_typed, 'attempts', l.attempts,
      'firstSeen', l.first_seen, 'lastSeen', l.last_seen,
      'typed', coalesce((SELECT jsonb_agg(jsonb_build_object('locale', s.locale, 'typed', hq.answer_gaps_text(s.typed))) FROM content_gap_samples s WHERE s.gap_id = l.id), '[]'::jsonb),
      'context', l.ctx,
      'contextHash', md5(l.ctx::text)
    ) ORDER BY l.name_typed DESC, l.game, l.norm, l.count DESC, l.id), '[]'::jsonb)
  ) INTO out
  FROM (SELECT leased.*, hq.content_gap_context(leased.game, leased.board_key, leased.resolved_id, leased.candidate_ids, leased.context_fp) AS ctx,
               sum(leased.count) OVER (PARTITION BY leased.game, leased.norm) AS name_typed
          FROM leased) l;
  RETURN out;
END;
$$;

-- Romero's view of what waits on a decision: held fixes (with the verifier's result) and held gaps no fix covers.
CREATE OR REPLACE FUNCTION hq.content_held(p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'fixesHeld', (SELECT count(*) FROM content_gap_fixes WHERE status = 'held' AND coalesce(audit->-1->>'action', '') <> 'park'),
    -- Parked: right as far as Romero can tell, waiting for a way to publish that kind (not listed again).
    'fixesParked', (SELECT count(*) FROM content_gap_fixes WHERE status = 'held' AND audit->-1->>'action' = 'park'),
    'gapsHeld', (SELECT count(*) FROM content_gaps WHERE status = 'held' AND fix_id IS NULL),
    'fixes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', f.id, 'kind', f.kind, 'game', f.game, 'board', f.board_key, 'payload', f.payload,
        'evidence', f.evidence, 'context', f.context,
        'verifier', CASE WHEN f.verification IS NULL THEN NULL ELSE jsonb_build_object(
          'verdict', f.verification->'verdict', 'checks', f.verification->'checks', 'extracted', f.verification->'extracted',
          'sources', f.verification->'sources') END,
        'gaps', cardinality(f.gap_ids),
        'typed', (SELECT coalesce(sum(g.count), 0) FROM content_gaps g WHERE g.id = ANY(f.gap_ids)),
        'reverified', (SELECT count(*) FROM jsonb_array_elements(f.audit) a WHERE a->>'action' = 'reverify'),
        'heldSince', f.updated_at
      ) ORDER BY f.updated_at)
      FROM (SELECT * FROM content_gap_fixes WHERE status = 'held' AND coalesce(audit->-1->>'action', '') <> 'park'
            ORDER BY updated_at, id LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)) f
    ), '[]'::jsonb),
    'gaps', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', g.id, 'game', g.game, 'board', g.board_key, 'verdict', g.verdict, 'name', g.norm, 'count', g.count, 'attempts', g.attempts,
        'typed', coalesce((SELECT jsonb_agg(jsonb_build_object('locale', s.locale, 'typed', hq.answer_gaps_text(s.typed))) FROM content_gap_samples s WHERE s.gap_id = g.id), '[]'::jsonb),
        'lastSeen', g.last_seen
      ) ORDER BY g.count DESC)
      FROM (SELECT * FROM content_gaps WHERE status = 'held' AND fix_id IS NULL ORDER BY count DESC, id LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)) g
    ), '[]'::jsonb)
  );
$$;

-- Romero's decision on a held fix or held gaps. Fix: reverify (back to the Content Verifier, at most twice; only kinds it
-- can check), park (looks right, but nothing can publish that kind yet: kept, off his list), reject (gaps closed wontfix)
-- or reopen (fix rejected, gaps back in the queue for another try). Gaps with
-- no fix: reopen (one more try) or close (wontfix / correct / junk). Never verified: that stays the verifier's call.
CREATE OR REPLACE FUNCTION hq.content_held_decide(p_actor text, p_fix_id bigint, p_gap_ids bigint[], p_action text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  f record;
  n integer;
  entry jsonb;
  to_status text;
BEGIN
  IF coalesce(btrim(p_actor), '') = '' OR length(p_actor) > 120 THEN RAISE EXCEPTION 'actor required'; END IF;
  IF coalesce(length(btrim(p_reason)), 0) NOT BETWEEN 3 AND 400 THEN RAISE EXCEPTION 'a reason is required (3..400 characters)'; END IF;
  IF (p_fix_id IS NULL) = (cardinality(coalesce(p_gap_ids, '{}')) = 0) THEN RAISE EXCEPTION 'name a fix or gaps, not both'; END IF;
  entry := jsonb_build_object('at', now(), 'actor', p_actor, 'action', p_action, 'reason', btrim(p_reason));

  IF p_fix_id IS NOT NULL THEN
    SELECT * INTO f FROM content_gap_fixes WHERE id = p_fix_id FOR UPDATE;
    IF NOT FOUND OR f.status <> 'held' THEN RAISE EXCEPTION 'fix % is not held', p_fix_id; END IF;
    PERFORM 1 FROM content_gaps WHERE id = ANY(f.gap_ids) ORDER BY id FOR UPDATE;
    IF p_action = 'reverify' THEN
      IF NOT (f.kind IN ('stats', 'alias') OR (f.kind = 'membership' AND f.game IN ('football_grid', 'grid_daily'))) THEN
        RAISE EXCEPTION 'the verifier cannot check a % fix: reject or reopen it', f.kind;
      END IF;
      IF (SELECT count(*) FROM jsonb_array_elements(f.audit) a WHERE a->>'action' = 'reverify') >= 2 THEN
        RAISE EXCEPTION 'fix % was already sent back twice: reject or reopen it', p_fix_id;
      END IF;
      IF EXISTS (SELECT 1 FROM content_gaps WHERE id = ANY(f.gap_ids) AND (fix_id IS DISTINCT FROM p_fix_id OR status <> 'held')) THEN
        RAISE EXCEPTION 'some of fix %''s gaps moved on: reject or reopen it', p_fix_id;
      END IF;
      UPDATE content_gap_fixes SET status = 'proposed', verifier = NULL, verified_at = NULL, audit = audit || jsonb_build_array(entry),
             revision = revision + 1, updated_at = now() WHERE id = p_fix_id;
      UPDATE content_gaps SET status = 'proposed', revision = revision + 1, updated_at = now() WHERE id = ANY(f.gap_ids);
      RETURN jsonb_build_object('fixId', p_fix_id, 'status', 'proposed');
    ELSIF p_action = 'park' THEN
      IF coalesce(f.audit->-1->>'action', '') = 'park' THEN RAISE EXCEPTION 'fix % is already parked', p_fix_id; END IF;
      UPDATE content_gap_fixes SET audit = audit || jsonb_build_array(entry), revision = revision + 1, updated_at = now() WHERE id = p_fix_id;
      RETURN jsonb_build_object('fixId', p_fix_id, 'status', 'held', 'parked', true);
    ELSIF p_action IN ('reject', 'reopen') THEN
      UPDATE content_gap_fixes SET status = 'rejected', audit = audit || jsonb_build_array(entry), revision = revision + 1, updated_at = now()
       WHERE id = p_fix_id;
      to_status := CASE p_action WHEN 'reject' THEN 'wontfix' ELSE 'open' END;
      -- Reopened gaps leave 'held', so the backoff trigger does not count this as a failed try.
      UPDATE content_gaps SET status = to_status, fix_id = NULL, next_try_at = NULL,
             attempts = CASE WHEN p_action = 'reopen' THEN least(attempts, 2) ELSE attempts END,
             audit = audit || jsonb_build_array(entry || jsonb_build_object('from', status, 'to', to_status, 'fix', p_fix_id)),
             revision = revision + 1, updated_at = now()
       WHERE id = ANY(f.gap_ids) AND fix_id = p_fix_id AND status = 'held';
      GET DIAGNOSTICS n = ROW_COUNT;
      RETURN jsonb_build_object('fixId', p_fix_id, 'status', 'rejected', 'gaps', n, 'gapsTo', to_status);
    END IF;
    RAISE EXCEPTION 'action for a fix: reverify, park, reject or reopen';
  END IF;

  IF cardinality(p_gap_ids) > 25 THEN RAISE EXCEPTION 'at most 25 gaps at once'; END IF;
  IF p_action NOT IN ('reopen', 'wontfix', 'correct', 'junk') THEN RAISE EXCEPTION 'action for gaps: reopen, wontfix, correct or junk'; END IF;
  to_status := CASE p_action WHEN 'reopen' THEN 'open' ELSE p_action END;
  PERFORM 1 FROM content_gaps WHERE id = ANY(p_gap_ids) ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM content_gaps WHERE id = ANY(p_gap_ids) AND status = 'held' AND fix_id IS NULL) <> cardinality(p_gap_ids) THEN
    RAISE EXCEPTION 'every gap must be held with no fix (held fixes are decided by their fix id)';
  END IF;
  UPDATE content_gaps SET status = to_status, next_try_at = NULL,
         attempts = CASE WHEN p_action = 'reopen' THEN least(attempts, 3) ELSE attempts END,
         audit = audit || jsonb_build_array(entry || jsonb_build_object('from', status, 'to', to_status)),
         revision = revision + 1, updated_at = now()
   WHERE id = ANY(p_gap_ids);
  RETURN jsonb_build_object('gaps', cardinality(p_gap_ids), 'status', to_status);
END;
$$;

REVOKE ALL ON FUNCTION hq.content_gaps_claim(text, integer, integer, text), hq.content_held(integer),
  hq.content_held_decide(text, bigint, bigint[], text, text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION hq.content_gaps_claim(text, integer, integer, text), hq.content_held(integer),
      hq.content_held_decide(text, bigint, bigint[], text, text) TO service_role;
  END IF;
END $$;

-- Romero has the triage tools by role (worker); the Fixer's and Verifier's held paths now end with him, not "a person".
UPDATE hq.members SET instructions = replace(replace(instructions,
    '1. hq_content_gaps (up to 15).',
    '1. hq_content_gaps (up to 40). Gaps come grouped by NAME (the typed text): name and nameTyped tell you which gaps are the same name on different boards and how often it was typed in all. Research a name ONCE, then decide each of its gaps on its own board: the same name can be right on one board and wrong on another.'),
    'These go to a human; still give the evidence.',
    'These go to Romero (the Director), who decides what happens next; still give the evidence.'),
  updated_at = now()
 WHERE slug = 'answer-gap-monitor';

UPDATE hq.members SET instructions = instructions || $r$

UNRESOLVED NAMES: a gap you give back without a decision waits (6 h, then 1 day, then 3 days) and after its fourth try goes to Romero or is closed. So decide what you can; leave only what you could not establish.$r$,
  updated_at = now()
 WHERE slug = 'answer-gap-monitor' AND instructions NOT LIKE '%UNRESOLVED NAMES:%';

UPDATE hq.schedules s SET cron = '0 * * * *'
  FROM hq.members m WHERE m.id = s.member_id AND m.slug = 'answer-gap-monitor' AND s.task_title = 'Work the content-gap queue';
UPDATE hq.schedules s SET cron = '30 * * * *'
  FROM hq.members m WHERE m.id = s.member_id AND m.slug = 'content-verifier' AND s.task_title = 'Verify proposed fixes';
