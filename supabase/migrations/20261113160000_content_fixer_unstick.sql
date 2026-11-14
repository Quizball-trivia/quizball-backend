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

-- Gaps the old claim kept re-taking start with some of the tries they had, counted low (a claim and its give-back add
-- two revisions, a disagreed proposal three, a person's decision one): at most two, so each still gets two more.
UPDATE public.content_gaps
   SET attempts = CASE WHEN revision >= 8 THEN 2 ELSE 1 END,
       next_try_at = CASE WHEN revision >= 8 THEN now() + interval '1 day' END
 WHERE status = 'open' AND revision >= 4 AND attempts = 0;

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
  ), totals AS (
    -- How often each name with claimable gaps was typed over ALL its open boards (also those still waiting).
    SELECT o.game, o.norm, sum(o.count) AS typed
    FROM content_gaps o
    WHERE o.status = 'open' AND (o.game, o.norm) IN (SELECT DISTINCT game, norm FROM ready)
    GROUP BY o.game, o.norm
  ), names AS (
    -- More names than one claim takes: rows another run or a recorder flush holds are skipped below, not waited for.
    SELECT game, norm, typed, row_number() OVER (ORDER BY typed DESC, game, norm) AS rk
    FROM totals
    ORDER BY typed DESC, game, norm
    LIMIT 200
  ), ranked AS (
    SELECT r.id, n.rk, row_number() OVER (PARTITION BY r.game, r.norm ORDER BY r.count DESC, r.id) AS rn
    FROM ready r JOIN names n ON n.game = r.game AND n.norm = r.norm
  ), picked AS (
    SELECT g.id FROM content_gaps g JOIN ranked k ON k.id = g.id
    WHERE k.rn <= 25 AND g.status = 'open' AND (g.next_try_at IS NULL OR g.next_try_at <= now())
    ORDER BY k.rk, k.rn
    LIMIT p_limit
    FOR UPDATE OF g SKIP LOCKED
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
      -- The name this gap belongs to and how often it was typed over all its open boards: research it once.
      'name', hq.answer_gaps_text(l.norm), 'nameTyped', l.name_typed, 'attempts', l.attempts,
      'firstSeen', l.first_seen, 'lastSeen', l.last_seen,
      'typed', coalesce((SELECT jsonb_agg(jsonb_build_object('locale', s.locale, 'typed', hq.answer_gaps_text(s.typed))) FROM content_gap_samples s WHERE s.gap_id = l.id), '[]'::jsonb),
      'context', l.ctx,
      'contextHash', md5(l.ctx::text)
    ) ORDER BY l.name_rank, l.count DESC, l.id), '[]'::jsonb)
  ) INTO out
  FROM (SELECT leased.*, hq.content_gap_context(leased.game, leased.board_key, leased.resolved_id, leased.candidate_ids, leased.context_fp) AS ctx,
               n.typed AS name_typed, n.rk AS name_rank
          FROM leased JOIN names n ON n.game = leased.game AND n.norm = leased.norm) l;
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
    -- A held gap with no live fix: none, or one a person rejected in the CMS (it kept the gap held).
    'gapsHeld', (SELECT count(*) FROM content_gaps hg WHERE hg.status = 'held' AND (hg.fix_id IS NULL OR NOT EXISTS (SELECT 1 FROM content_gap_fixes lf WHERE lf.id = hg.fix_id AND lf.status IN ('held', 'proposed', 'verified')))),
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
    -- Content the Fixer says is itself wrong (closed wontfix "question wrong…" in the last 7 days): Romero sends it on.
    'questionReports', coalesce((
      -- Aged by the closure itself (players typing the name again only refresh updated_at).
      SELECT jsonb_agg(jsonb_build_object('id', g.id, 'game', g.game, 'board', g.board_key, 'name', hq.answer_gaps_text(g.norm), 'count', g.count,
                                          'reason', g.audit->-1->>'reason', 'evidence', g.audit->-1->'evidence', 'closedAt', g.closed_at) ORDER BY g.closed_at DESC)
      FROM (SELECT *, (audit->-1->>'at')::timestamptz AS closed_at FROM content_gaps
             WHERE status = 'wontfix' AND audit->-1->>'reason' ILIKE 'question wrong%'
               AND (audit->-1->>'at')::timestamptz > now() - interval '7 days'
             ORDER BY (audit->-1->>'at')::timestamptz DESC LIMIT 20) g
    ), '[]'::jsonb),
    'gaps', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', g.id, 'game', g.game, 'board', g.board_key, 'verdict', g.verdict, 'name', hq.answer_gaps_text(g.norm), 'count', g.count, 'attempts', g.attempts,
        'typed', coalesce((SELECT jsonb_agg(jsonb_build_object('locale', s.locale, 'typed', hq.answer_gaps_text(s.typed))) FROM content_gap_samples s WHERE s.gap_id = g.id), '[]'::jsonb),
        'lastSeen', g.last_seen
      ) ORDER BY g.count DESC)
      FROM (SELECT * FROM content_gaps hg WHERE hg.status = 'held' AND (hg.fix_id IS NULL OR NOT EXISTS (SELECT 1 FROM content_gap_fixes lf WHERE lf.id = hg.fix_id AND lf.status IN ('held', 'proposed', 'verified'))) ORDER BY count DESC, id LIMIT least(greatest(coalesce(p_limit, 20), 1), 50)) g
    ), '[]'::jsonb)
  );
$$;

-- Romero's decision on a held fix or held gaps. Fix: reverify (back to the Content Verifier, at most twice; only kinds it
-- can check), park (looks right, but nothing can publish that kind yet: kept, off his list), reject (gaps closed wontfix)
-- or reopen (fix rejected, gaps back in the queue for another try). Gaps with
-- no live fix (none, or one rejected in the CMS): reopen (one more try) or close (wontfix / correct / junk). Never verified: that stays the verifier's call.
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
      IF (SELECT count(*) FROM content_gaps WHERE id = ANY(f.gap_ids) AND fix_id = p_fix_id AND status = 'held') <> cardinality(f.gap_ids) THEN
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
  IF (SELECT count(*) FROM content_gaps hg WHERE hg.id = ANY(p_gap_ids) AND hg.status = 'held' AND (hg.fix_id IS NULL OR NOT EXISTS (SELECT 1 FROM content_gap_fixes lf WHERE lf.id = hg.fix_id AND lf.status IN ('held', 'proposed', 'verified')))) <> cardinality(p_gap_ids) THEN
    RAISE EXCEPTION 'every gap must be held with no live fix (held fixes are decided by their fix id)';
  END IF;
  UPDATE content_gaps SET status = to_status, next_try_at = NULL, fix_id = NULL,
         attempts = CASE WHEN p_action = 'reopen' THEN least(attempts, 3) ELSE attempts END,
         audit = audit || jsonb_build_array(entry || jsonb_build_object('from', status, 'to', to_status)),
         revision = revision + 1, updated_at = now()
   WHERE id = ANY(p_gap_ids);
  RETURN jsonb_build_object('gaps', cardinality(p_gap_ids), 'status', to_status);
END;
$$;

-- Closures keep their reason and cited sources (copied from 20261113150000; only the closing branch changes).
CREATE OR REPLACE FUNCTION hq.content_gap_propose(p_owner text, p_token uuid, p_gap_ids bigint[], p_kind text, p_payload jsonb, p_evidence jsonb, p_context_hashes jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  held integer;
  g record;
  first_ctx jsonb;
  ctx jsonb;
  problem text;
  new_fix bigint;
  closing boolean := p_kind IN ('junk', 'correct', 'wontfix');
  grid boolean;
  human_only boolean;
  keys text[];
BEGIN
  IF cardinality(coalesce(p_gap_ids, '{}')) NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'between 1 and 25 gaps'; END IF;
  IF NOT (closing OR human_only OR p_kind IN ('stats', 'alias')) THEN RAISE EXCEPTION 'unknown kind %', p_kind; END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'payload must be an object'; END IF;
  SELECT count(*) INTO held FROM (
    SELECT 1 FROM content_gaps WHERE id = ANY(p_gap_ids) AND status = 'checking' AND lease_owner = p_owner AND lease_token = p_token AND lease_until > now()
    ORDER BY id FOR UPDATE
  ) x;
  IF held <> cardinality(p_gap_ids) THEN RAISE EXCEPTION 'every gap must be checking under your unexpired claim'; END IF;
  IF (SELECT count(DISTINCT (game, board_key)) FROM content_gaps WHERE id = ANY(p_gap_ids)) <> 1 THEN RAISE EXCEPTION 'all gaps of one fix must be on the same board'; END IF;
  -- Grid memberships are cited facts a reviewed correction release can carry, so a second agent may verify them; on
  -- other games a membership still goes to a person.
  grid := (SELECT game FROM content_gaps WHERE id = p_gap_ids[1]) IN ('football_grid', 'grid_daily');
  human_only := p_kind IN ('namesake', 'accepted', 'needs_entity') OR (p_kind = 'membership' AND NOT grid);

  IF closing THEN
    IF coalesce(length(p_payload->>'reason'), 0) NOT BETWEEN 3 AND 400 THEN RAISE EXCEPTION 'a closure needs a reason (3..400 characters)'; END IF;
    -- The reason (and any sources cited) stays on the gap: Romero reads "question wrong" reports from it.
    UPDATE content_gaps SET status = p_kind, lease_owner = NULL, lease_token = NULL, lease_until = NULL, revision = revision + 1, updated_at = now(),
           audit = audit || jsonb_build_array(jsonb_build_object(
             'at', now(), 'actor', p_owner, 'action', p_kind, 'from', 'checking', 'to', p_kind, 'reason', left(btrim(p_payload->>'reason'), 400),
             'evidence', CASE WHEN p_evidence IS NOT NULL AND jsonb_typeof(p_evidence) = 'array' AND jsonb_array_length(p_evidence) > 0
                                   AND hq.content_evidence_problem(p_evidence) IS NULL THEN p_evidence ELSE '[]'::jsonb END))
    WHERE id = ANY(p_gap_ids);
    RETURN jsonb_build_object('closed', cardinality(p_gap_ids), 'status', p_kind);
  END IF;

  problem := hq.content_evidence_problem(p_evidence);
  IF problem IS NOT NULL THEN RAISE EXCEPTION '%', problem; END IF;
  -- Every gap: its context unchanged since the claim, the same board content, and (stats) the footballer it is about.
  FOR g IN SELECT * FROM content_gaps WHERE id = ANY(p_gap_ids) ORDER BY id LOOP
    ctx := hq.content_gap_context(g.game, g.board_key, g.resolved_id, g.candidate_ids, g.context_fp);
    IF md5(ctx::text) IS DISTINCT FROM (p_context_hashes->>(g.id::text)) THEN RAISE EXCEPTION 'the board changed since the claim (gap %): claim again', g.id; END IF;
    IF first_ctx IS NULL THEN
      first_ctx := ctx;
    ELSIF (ctx->>'contentHash') IS DISTINCT FROM (first_ctx->>'contentHash') THEN
      RAISE EXCEPTION 'all gaps of one fix must be on the same board content';
    END IF;
    IF p_kind = 'stats' AND NOT coalesce(
         (g.resolved_id IS NULL AND g.candidate_ids IS NULL)
         OR g.resolved_id IS NOT DISTINCT FROM (p_payload->>'pid')
         OR coalesce((p_payload->>'pid') = ANY(coalesce(g.candidate_ids, '{}')), false), false) THEN
      RAISE EXCEPTION 'gap % is about someone else (use namesake if our matcher picked the wrong person)', g.id;
    END IF;
  END LOOP;
  SELECT * INTO g FROM content_gaps WHERE id = p_gap_ids[1];
  ctx := first_ctx;

  IF p_kind = 'stats' THEN
    IF g.game <> 'darts501' OR NOT coalesce((ctx->>'found')::boolean, false) THEN RAISE EXCEPTION 'stats fixes are for Darts 501 boards'; END IF;
    IF coalesce(p_payload->>'pid', '') = '' OR NOT EXISTS (SELECT 1 FROM wordgame_players w WHERE w.release_id = ctx->>'release' AND w.pid = p_payload->>'pid') THEN
      RAISE EXCEPTION 'pid must be a footballer of the board''s release';
    END IF;
    IF (p_payload->>'asOf') IS DISTINCT FROM (ctx->>'asOf') OR ctx->>'asOf' IS NULL THEN RAISE EXCEPTION 'asOf must be the board''s (%)', ctx->>'asOf'; END IF;
    problem := hq.content_stats_problem(p_payload->'leagues');
    IF problem IS NOT NULL THEN RAISE EXCEPTION '%', problem; END IF;
  ELSIF p_kind = 'membership' AND grid THEN
    IF NOT coalesce((ctx->>'found')::boolean, false) THEN RAISE EXCEPTION 'the cell''s criteria are not in a published release'; END IF;
    IF ctx->>'targetRelease' IS NULL THEN RAISE EXCEPTION 'no published release holds both of this cell''s criteria'; END IF;
    IF coalesce(p_payload->>'pid', '') = '' OR NOT EXISTS (SELECT 1 FROM football_players fp WHERE fp.id::text = p_payload->>'pid') THEN
      RAISE EXCEPTION 'pid must be a footballer of our database (from the context''s people)';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(ctx->'people') p WHERE p->>'id' = p_payload->>'pid') THEN
      RAISE EXCEPTION 'pid must be one of the people the matcher read the answer as (context.people)';
    END IF;
    IF jsonb_typeof(p_payload->'criterionKeys') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'criterionKeys must be an array'; END IF;
    SELECT array_agg(DISTINCT k ORDER BY k) INTO keys FROM jsonb_array_elements_text(p_payload->'criterionKeys') k;
    IF cardinality(coalesce(keys, '{}')) NOT BETWEEN 1 AND 2 OR jsonb_array_length(p_payload->'criterionKeys') <> cardinality(keys)
       OR NOT keys <@ ARRAY[ctx->>'rowKey', ctx->>'columnKey'] THEN
      RAISE EXCEPTION 'criterionKeys: 1 or 2 distinct keys of this cell (%, %)', ctx->>'rowKey', ctx->>'columnKey';
    END IF;
    -- Only facts we lack, and every fact the cell still lacks for him: after it he must be right for the cell.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(ctx->'people') p WHERE p->>'id' = p_payload->>'pid'
                 AND ((ctx->>'rowKey' = ANY(keys) AND (p->>'inRow')::boolean) OR (ctx->>'columnKey' = ANY(keys) AND (p->>'inColumn')::boolean)
                      OR (NOT (p->>'inRow')::boolean AND NOT ctx->>'rowKey' = ANY(keys))
                      OR (NOT (p->>'inColumn')::boolean AND NOT ctx->>'columnKey' = ANY(keys)))) THEN
      RAISE EXCEPTION 'criterionKeys must be exactly the cell''s criteria this footballer lacks (see inRow / inColumn)';
    END IF;
    p_payload := jsonb_build_object('pid', p_payload->>'pid', 'criterionKeys', to_jsonb(keys),
                                    'fact', left(coalesce(p_payload->>'fact', ''), 400));
    IF length(p_payload->>'fact') < 10 THEN RAISE EXCEPTION 'membership needs fact: one sentence (10..400) stating what he did, e.g. club spell with years'; END IF;
  ELSIF p_kind = 'alias' THEN
    IF coalesce(p_payload->>'entityId', '') = '' OR coalesce(p_payload->>'locale', '') NOT IN ('es', 'en', 'ka', 'tr', 'ru', 'pt', 'de', 'fr')
       OR coalesce(length(btrim(p_payload->>'text')), 0) NOT BETWEEN 2 AND 60 THEN
      RAISE EXCEPTION 'alias needs entityId, a locale of the eight and text (2..60)';
    END IF;
    -- The entity must exist in THIS board's directory: Darts reads the board's player release; Tenable its list's kind
    -- and release. Other games have no alias publisher yet: their aliases go to a person (namesake / needs_entity).
    IF g.game = 'darts501' THEN
      IF NOT EXISTS (SELECT 1 FROM wordgame_players w WHERE w.release_id = ctx->>'release' AND w.pid = p_payload->>'entityId') THEN
        RAISE EXCEPTION 'entityId must be a footballer of the board''s release';
      END IF;
    ELSIF g.game = 'tenable' THEN
      IF ctx->>'kind' = 'player' THEN
        IF NOT EXISTS (SELECT 1 FROM wordgame_players w WHERE w.release_id = ctx->>'release' AND w.pid = p_payload->>'entityId') THEN
          RAISE EXCEPTION 'entityId must be in the list''s release';
        END IF;
      ELSIF to_regclass('public.tenable_entities') IS NULL OR NOT EXISTS (
          SELECT 1 FROM tenable_entities e WHERE e.release_id = ctx->>'release' AND e.kind = ctx->>'kind' AND e.eid = p_payload->>'entityId') THEN
        RAISE EXCEPTION 'entityId must be a % of the list''s release', ctx->>'kind';
      END IF;
    ELSIF grid THEN
      -- An alias accepts exactly what was typed: every gap of the fix must be that spelling, so one alias cannot close
      -- another name typed into the same cell.
      -- Compared with what players typed, through one normaliser on both sides (the recorder's norm is a different one:
      -- it turns an apostrophe into a space, this one drops it).
      IF EXISTS (SELECT 1 FROM content_gaps cg WHERE cg.id = ANY(p_gap_ids)
                  AND NOT EXISTS (SELECT 1 FROM content_gap_samples s
                                   WHERE s.gap_id = cg.id AND hq.answer_gaps_norm(s.typed) = hq.answer_gaps_norm(p_payload->>'text'))) THEN
        RAISE EXCEPTION 'a Grid alias must be the typed text of every gap it fixes';
      END IF;
      -- A spelling fix only: the footballer must already be right for this cell in ONE release (the target).
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(ctx->'people') p
                      WHERE p->>'id' = p_payload->>'entityId' AND (p->>'inRow')::boolean AND (p->>'inColumn')::boolean)
         AND NOT EXISTS (SELECT 1 FROM football_grid_content_releases r
                          WHERE r.status = 'published' AND r.version::text = ctx->>'targetRelease'
                            AND EXISTS (SELECT 1 FROM football_grid_criterion_memberships m JOIN football_grid_criteria c ON c.id = m.criterion_id
                                         WHERE m.release_id = r.id AND c.criterion_key = ctx->>'rowKey' AND m.football_player_id::text = p_payload->>'entityId')
                            AND EXISTS (SELECT 1 FROM football_grid_criterion_memberships m JOIN football_grid_criteria c ON c.id = m.criterion_id
                                         WHERE m.release_id = r.id AND c.criterion_key = ctx->>'columnKey' AND m.football_player_id::text = p_payload->>'entityId')) THEN
        RAISE EXCEPTION 'entityId must be a footballer already right for this cell (else propose membership)';
      END IF;
    ELSE
      RAISE EXCEPTION 'aliases for % go to a person: propose namesake or needs_entity', g.game;
    END IF;
  END IF;

  INSERT INTO content_gap_fixes (kind, game, board_key, gap_ids, payload, evidence, context, context_hash, status, proposer)
  VALUES (p_kind, g.game, g.board_key, p_gap_ids, p_payload, p_evidence, ctx, md5(ctx::text), CASE WHEN human_only THEN 'held' ELSE 'proposed' END, p_owner)
  RETURNING id INTO new_fix;
  UPDATE content_gaps SET status = CASE WHEN human_only THEN 'held' ELSE 'proposed' END, fix_id = new_fix,
         lease_owner = NULL, lease_token = NULL, lease_until = NULL, revision = revision + 1, updated_at = now()
  WHERE id = ANY(p_gap_ids);
  RETURN jsonb_build_object('fixId', new_fix, 'status', CASE WHEN human_only THEN 'held' ELSE 'proposed' END);
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
