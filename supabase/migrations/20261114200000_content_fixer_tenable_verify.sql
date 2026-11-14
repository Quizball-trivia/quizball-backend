-- Content Fixer, unblocked (owner 2026-11-14: in four days 30 fixes, none verified).
-- 1. Tenable: the gap context shows the board (its answers in order with name and figure) and, per person the player
--    may have meant, their name and whether the list holds them. Until now it gave only ids, so the Fixer could not
--    tell a wrong answer from a missing one.
-- 2. Stats: every Darts stats fix was held because the Verifier left out the cut-off (its tables matched). A
--    verification without asOf is now refused with the reason, so the Verifier retries in the same run; the cut-off
--    must still be the claim's.
-- 3. Aliases keep needing two publishers. Every alias was held on Wikipedia + Wikidata (one publisher): the Verifier
--    is told to find an independent second source.
-- 4. Tenable gaps leased when this runs would fail their context-hash check; they go back to the queue now, at no
--    cost in attempts.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- A Tenable entity's name: players from the word games' footballer release, managers / clubs / nations from
-- tenable_entities (the list's release names one or the other).
CREATE OR REPLACE FUNCTION hq.content_tenable_name(p_kind text, p_release text, p_eid text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF p_kind = 'player' THEN
    RETURN (SELECT w.name FROM wordgame_players w WHERE w.release_id = p_release AND w.pid = p_eid LIMIT 1);
  END IF;
  RETURN (SELECT e.name FROM tenable_entities e WHERE e.release_id = p_release AND e.kind = p_kind AND e.eid = p_eid LIMIT 1);
END;
$$;
REVOKE ALL ON FUNCTION hq.content_tenable_name(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION hq.content_tenable_name(text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION hq.content_gap_context(p_game text, p_board text, p_resolved text, p_candidates text[], p_recorded text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  cat jsonb;
  people text[] := array_remove(array_cat(ARRAY[p_resolved], coalesce(p_candidates, '{}')), NULL);
  out jsonb;
  v_board uuid;
  v_cell integer;
  v_release uuid;
  v_target uuid;
  v_qtype text;
  v_qstatus text;
  v_prompt text;
  v_row text;
  v_col text;
  v_people jsonb;
BEGIN
  IF p_game = 'darts501' THEN
    SELECT d.category INTO cat FROM darts501_days d WHERE d.category->>'id' = p_board ORDER BY d.day DESC LIMIT 1;
    IF cat IS NULL THEN
      SELECT r.payload INTO cat FROM room_pool r WHERE r.game = 'darts501' AND r.payload->>'id' = p_board AND r.enabled LIMIT 1;
    END IF;
    IF cat IS NULL THEN RETURN jsonb_build_object('game', p_game, 'board', p_board, 'found', false); END IF;
    SELECT jsonb_build_object(
      'game', p_game, 'board', p_board, 'found', true,
      -- The whole category (entries, matcher, note…): any change to the board changes this.
      'contentHash', md5(cat::text),
      -- Fixes target the CURRENT board (P3 publishes to it). When the typings were judged on an earlier revision
      -- (another release or coverage), the board has been corrected since: check whether it still lacks the answer.
      'recorded', p_recorded,
      'stale', p_recorded IS NOT NULL AND NOT starts_with(p_recorded, (cat->>'release') || '|' || (cat->>'coverage') || '|'),
      'title', cat->'title'->>'en', 'unit', cat->>'unit', 'asOf', cat->>'asOf', 'release', cat->>'release', 'coverage', cat->>'coverage',
      'people', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'id', p.pid, 'name', w.name, 'fame', w.fame,
          'covered', EXISTS (SELECT 1 FROM darts501_coverage c WHERE c.coverage_id = cat->>'coverage' AND c.pid = p.pid),
          'value', (SELECT (e->>'value')::int FROM jsonb_array_elements(cat->'entries') e WHERE e->>'eid' = p.pid LIMIT 1)
        ) ORDER BY p.ord)
        FROM unnest(people) WITH ORDINALITY AS p(pid, ord)
        LEFT JOIN wordgame_players w ON w.release_id = cat->>'release' AND w.pid = p.pid
      ), '[]'::jsonb)
    ) INTO out;
    RETURN out;
  ELSIF p_game = 'tenable' THEN
    SELECT t.list INTO cat FROM tenable_days t WHERE t.list->>'id' = p_board ORDER BY t.day DESC LIMIT 1;
    IF cat IS NULL THEN
      SELECT r.payload INTO cat FROM room_pool r WHERE r.game = 'tenable' AND r.payload->>'id' = p_board AND r.enabled LIMIT 1;
    END IF;
    IF cat IS NULL THEN RETURN jsonb_build_object('game', p_game, 'board', p_board, 'found', false); END IF;
    -- The board itself: its answers in order (name and figure), and per person the player may have meant, their name
    -- and whether the list already holds them. Without it the Fixer cannot tell a wrong answer from a missing one.
    RETURN jsonb_build_object('game', p_game, 'board', p_board, 'found', true, 'contentHash', md5(cat::text),
                              'recorded', p_recorded,
                              'stale', p_recorded IS NOT NULL AND NOT starts_with(p_recorded, (cat->>'kind') || '|' || (cat->>'release') || '|'),
                              'title', cat->'title'->>'en', 'kind', cat->>'kind', 'release', cat->>'release', 'asOf', cat->>'asOf',
                              -- The board's ranking rule (ties, what counts), when it has one.
                              'note', cat->'note'->>'en',
                              'slots', coalesce((
                                SELECT jsonb_agg(jsonb_build_object(
                                  'rank', s.ord, 'id', s.e->>'eid',
                                  'name', hq.content_tenable_name(cat->>'kind', cat->>'release', s.e->>'eid'),
                                  'value', s.e->'figure'->'value', 'unit', s.e->'figure'->>'unit') ORDER BY s.ord)
                                FROM jsonb_array_elements(CASE WHEN jsonb_typeof(cat->'slots') = 'array' THEN cat->'slots' ELSE '[]'::jsonb END) WITH ORDINALITY AS s(e, ord)), '[]'::jsonb),
                              'people', coalesce((
                                SELECT jsonb_agg(jsonb_build_object(
                                  'id', p.pid, 'name', hq.content_tenable_name(cat->>'kind', cat->>'release', p.pid),
                                  'onList', EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(cat->'slots') = 'array' THEN cat->'slots' ELSE '[]'::jsonb END) s
                                                     WHERE s->>'eid' = p.pid)) ORDER BY p.ord)
                                FROM unnest(people) WITH ORDINALITY AS p(pid, ord)), '[]'::jsonb));
  ELSIF p_game IN ('football_grid', 'grid_daily') THEN
    -- A played cell is '<board id>#<cell>'; a player's report names the cell's two criterion keys, 'row|column'.
    IF p_board ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}#[0-8]$' THEN
      v_board := split_part(p_board, '#', 1)::uuid;
      v_cell := split_part(p_board, '#', 2)::integer;
      SELECT b.release_id, rc.criterion_key, cc.criterion_key INTO v_release, v_row, v_col
        FROM football_grid_boards b
        JOIN football_grid_criteria rc ON rc.id = b.row_criteria[v_cell / 3 + 1]
        JOIN football_grid_criteria cc ON cc.id = b.column_criteria[v_cell % 3 + 1]
       WHERE b.id = v_board;
    ELSIF p_board ~ '^[^|#]{1,80}\|[^|#]{1,80}$' THEN
      v_row := split_part(p_board, '|', 1);
      v_col := split_part(p_board, '|', 2);
    END IF;
    IF v_row IS NULL
       OR NOT EXISTS (SELECT 1 FROM football_grid_criteria c JOIN football_grid_content_releases r ON r.id = c.release_id
                       WHERE r.status = 'published' AND c.criterion_key = v_row)
       OR NOT EXISTS (SELECT 1 FROM football_grid_criteria c JOIN football_grid_content_releases r ON r.id = c.release_id
                       WHERE r.status = 'published' AND c.criterion_key = v_col) THEN
      RETURN jsonb_build_object('game', p_game, 'board', p_board, 'found', false, 'people', to_jsonb(people));
    END IF;
    -- A footballer is right for a cell only when ONE release holds both facts (the daily grid's carried answers and a
    -- new board both read a single release), so the flags are read in the target: the newest published release that
    -- has both criteria, the one a correction release would build on. None (the keys never met in one release): found.
    SELECT r.id INTO v_target FROM football_grid_content_releases r
     WHERE r.status = 'published'
       -- Not switched off as a whole (a later enable lifts a disable, as the game reads it).
       AND NOT EXISTS (SELECT 1 FROM football_grid_content_quarantines q
                        WHERE q.release_id = r.id AND q.board_id IS NULL AND q.action = 'disable'
                          AND (q.expires_at IS NULL OR q.expires_at > now())
                          AND NOT EXISTS (SELECT 1 FROM football_grid_content_quarantines newer
                                           WHERE newer.release_id = q.release_id AND newer.board_id IS NULL AND newer.action = 'enable'
                                             AND (newer.created_at, newer.id) > (q.created_at, q.id)))
       AND EXISTS (SELECT 1 FROM football_grid_criteria c WHERE c.release_id = r.id AND c.criterion_key = v_row)
       AND EXISTS (SELECT 1 FROM football_grid_criteria c WHERE c.release_id = r.id AND c.criterion_key = v_col)
     ORDER BY r.version DESC LIMIT 1;
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'id', p.pid, 'name', fp.name, 'known', fp.id IS NOT NULL,
             'inRow', v_target IS NOT NULL AND EXISTS (SELECT 1 FROM football_grid_criterion_memberships m JOIN football_grid_criteria c ON c.id = m.criterion_id
                               WHERE m.release_id = v_target AND c.criterion_key = v_row AND m.football_player_id::text = p.pid),
             'inColumn', v_target IS NOT NULL AND EXISTS (SELECT 1 FROM football_grid_criterion_memberships m JOIN football_grid_criteria c ON c.id = m.criterion_id
                                  WHERE m.release_id = v_target AND c.criterion_key = v_col AND m.football_player_id::text = p.pid),
      'onBoard', v_board IS NOT NULL AND EXISTS (SELECT 1 FROM football_grid_board_answers a
                                                        WHERE a.board_id = v_board AND a.cell_index = v_cell AND a.football_player_id::text = p.pid)
           ) ORDER BY p.ord), '[]'::jsonb)
      INTO v_people
      FROM (SELECT u.pid, min(u.ord) AS ord FROM unnest(people) WITH ORDINALITY AS u(pid, ord) GROUP BY u.pid) p
      LEFT JOIN football_players fp ON fp.id::text = p.pid;
    SELECT jsonb_build_object(
      'game', p_game, 'board', p_board, 'found', true, 'recorded', p_recorded,
      'boardId', v_board, 'cell', v_cell, 'release', v_release,
      'latestRelease', (SELECT max(version) FROM football_grid_content_releases WHERE status = 'published'),
      'targetRelease', (SELECT version FROM football_grid_content_releases WHERE id = v_target),
      'rowKey', v_row, 'columnKey', v_col,
      'rowLabel', (SELECT c.label_en FROM football_grid_criteria c JOIN football_grid_content_releases r ON r.id = c.release_id
                    WHERE r.status = 'published' AND c.criterion_key = v_row ORDER BY r.version DESC LIMIT 1),
      'columnLabel', (SELECT c.label_en FROM football_grid_criteria c JOIN football_grid_content_releases r ON r.id = c.release_id
                       WHERE r.status = 'published' AND c.criterion_key = v_col ORDER BY r.version DESC LIMIT 1),
      'cellAnswers', CASE WHEN v_board IS NULL THEN NULL
                          ELSE (SELECT count(*) FROM football_grid_board_answers a WHERE a.board_id = v_board AND a.cell_index = v_cell) END,
      'people', v_people
    ) INTO out;
    -- The cell's content (target and newest releases, the cell's list), the same for every gap typed into it, so one fix
    -- can cover several of them. Each gap's own context hash (people included) still moves when a fact is published.
    RETURN out || jsonb_build_object('contentHash', md5((out - 'recorded' - 'people')::text));
  ELSIF p_game IN ('clue_chain', 'countdown_list') THEN
    -- Ranked: the board is the question. The Fixer reads the question in English and the answers it accepts now
    -- (Who Am I: display answer + accepted answers in every language; Countdown: the answer groups).
    IF p_board !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN jsonb_build_object('game', p_game, 'board', p_board, 'found', false);
    END IF;
    -- What the game shows: the payload's prompt when it has one (Countdown), else the question's.
    SELECT q.type, q.status, coalesce(qp.payload->'prompt'->>'en', q.prompt->>'en', q.prompt::text), qp.payload INTO v_qtype, v_qstatus, v_prompt, cat
      FROM questions q JOIN question_payloads qp ON qp.question_id = q.id
     WHERE q.id = p_board::uuid AND q.type = p_game
     ORDER BY qp.updated_at DESC LIMIT 1;
    IF cat IS NULL THEN RETURN jsonb_build_object('game', p_game, 'board', p_board, 'found', false); END IF;
    RETURN jsonb_build_object(
      'game', p_game, 'board', p_board, 'found', true, 'recorded', p_recorded, 'contentHash', md5(cat::text),
      'questionStatus', v_qstatus, 'prompt', left(v_prompt, 400),
      'clues', CASE WHEN p_game = 'clue_chain' THEN (SELECT jsonb_agg(coalesce(c->'content'->>'en', c->>'en', c::text)) FROM jsonb_array_elements(coalesce(cat->'clues', '[]'::jsonb)) c) END,
      'displayAnswer', cat->'display_answer',
      'acceptedAnswers', CASE WHEN p_game = 'clue_chain' THEN cat->'accepted_answers' END,
      'answerGroups', CASE WHEN p_game = 'countdown_list' THEN cat->'answer_groups' END);
  ELSIF p_game = 'squad_spin' THEN
    -- Squad Spin: the board is a combo (club, nation, position, extras); the answers are its footballers.
    IF p_board !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN jsonb_build_object('game', p_game, 'board', p_board, 'found', false);
    END IF;
    SELECT jsonb_build_object(
      'game', p_game, 'board', p_board, 'found', true, 'recorded', p_recorded,
      'contentHash', md5(concat_ws('|', c.content_version, c.answer_ids::text, c.extra_ids::text)),
      'active', c.active, 'tier', c.tier, 'position', c.position_group,
      'criteria', (SELECT coalesce(jsonb_agg(k.label_en ORDER BY k.family, k.label_en), '[]'::jsonb) FROM squad_spin_criteria k
                    WHERE k.id = c.club_id OR k.id = c.nation_id OR k.id = ANY(coalesce(c.extra_ids, '{}'))),
      'answers', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', pl.id, 'name', pl.name_en) ORDER BY pl.name_en), '[]'::jsonb)
                   FROM squad_spin_players pl WHERE pl.id = ANY(c.answer_ids)))
      INTO out FROM squad_spin_combos c WHERE c.id = p_board::uuid;
    RETURN coalesce(out, jsonb_build_object('game', p_game, 'board', p_board, 'found', false));
  END IF;
  RETURN jsonb_build_object('game', p_game, 'board', p_board, 'found', false, 'people', to_jsonb(people));
END;
$$;

CREATE OR REPLACE FUNCTION hq.content_fix_verify(p_owner text, p_token uuid, p_fix_id bigint, p_verdict text, p_extracted jsonb, p_sources jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  f record;
  problem text;
  publishers integer;
  bound boolean;
  matches boolean := false;
  outcome text;
  checks jsonb;
BEGIN
  IF coalesce(p_verdict, '') NOT IN ('agree', 'disagree', 'unsure') THEN RAISE EXCEPTION 'verdict must be agree, disagree or unsure'; END IF;
  IF p_extracted IS NULL OR jsonb_typeof(p_extracted) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'extracted must be an object'; END IF;
  SELECT * INTO f FROM content_gap_fixes WHERE id = p_fix_id FOR UPDATE;
  IF NOT FOUND OR f.status <> 'proposed' OR f.lease_owner IS DISTINCT FROM p_owner OR p_owner IS NULL OR p_token IS NULL OR f.lease_token IS DISTINCT FROM p_token OR coalesce(f.lease_until <= now(), true) THEN
    RAISE EXCEPTION 'the fix must be proposed and under your unexpired claim';
  END IF;
  IF hq.content_member(f.proposer) = hq.content_member(p_owner) THEN RAISE EXCEPTION 'a proposer cannot verify its own fix'; END IF;
  problem := hq.content_evidence_problem(p_sources);
  IF problem IS NOT NULL THEN RAISE EXCEPTION '%', problem; END IF;
  SELECT count(DISTINCT hq.content_publisher(s->>'url')) INTO publishers FROM jsonb_array_elements(p_sources) s;
  SELECT count(*) = cardinality(f.gap_ids) INTO bound FROM (
    SELECT 1 FROM content_gaps WHERE id = ANY(f.gap_ids) AND fix_id = p_fix_id AND status = 'proposed' ORDER BY id FOR UPDATE
  ) x;

  IF f.kind = 'stats' THEN
    IF coalesce(btrim(p_extracted->>'asOf'), '') = '' THEN
      RAISE EXCEPTION 'extracted.asOf is required for stats: the date you confirmed the totals run through (the claim says %)', f.payload->>'asOf';
    END IF;
    problem := hq.content_stats_problem(p_extracted->'leagues');
    IF problem IS NOT NULL THEN RAISE EXCEPTION 'extracted: %', problem; END IF;
    matches := hq.content_stats_key(p_extracted->'leagues') IS NOT DISTINCT FROM hq.content_stats_key(f.payload->'leagues')
               AND hq.content_stats_key(f.payload->'leagues') IS NOT NULL
               AND (p_extracted->>'pid') IS NOT DISTINCT FROM (f.payload->>'pid')
               AND (p_extracted->>'asOf') IS NOT DISTINCT FROM (f.payload->>'asOf');
  ELSIF f.kind = 'membership' AND f.game IN ('football_grid', 'grid_daily') THEN
    matches := jsonb_typeof(p_extracted->'criterionKeys') = 'array'
               AND coalesce(p_extracted->>'pid', '') <> '' AND (p_extracted->>'pid') = (f.payload->>'pid')
               AND (SELECT array_agg(DISTINCT k ORDER BY k) FROM jsonb_array_elements_text(p_extracted->'criterionKeys') k)
                   IS NOT DISTINCT FROM (SELECT array_agg(k ORDER BY k) FROM jsonb_array_elements_text(f.payload->'criterionKeys') k);
  ELSIF f.kind = 'alias' THEN
    matches := coalesce(p_extracted->>'entityId', '') <> '' AND (p_extracted->>'entityId') = (f.payload->>'entityId')
               AND (p_extracted->>'locale') IS NOT DISTINCT FROM (f.payload->>'locale')
               AND hq.answer_gaps_norm(p_extracted->>'text') <> '' AND hq.answer_gaps_norm(p_extracted->>'text') = hq.answer_gaps_norm(f.payload->>'text');
  END IF;

  checks := jsonb_build_object('publishers', publishers, 'matches', matches, 'gapsBound', bound);
  outcome := CASE WHEN p_verdict = 'agree' AND matches AND publishers >= 2 AND bound THEN 'verified' ELSE 'held' END;
  UPDATE content_gap_fixes SET status = outcome, verifier = p_owner,
         verification = jsonb_build_object('verdict', p_verdict, 'extracted', p_extracted,
           'sources', (SELECT jsonb_agg(s || jsonb_build_object('publisher', hq.content_publisher(s->>'url'))) FROM jsonb_array_elements(p_sources) s),
           'checks', checks, 'at', now()),
         verified_at = CASE WHEN outcome = 'verified' THEN now() END,
         lease_owner = NULL, lease_token = NULL, lease_until = NULL, revision = revision + 1, updated_at = now()
  WHERE id = p_fix_id;
  -- Gaps follow the fix they are bound to (never a gap a person or a newer fix has taken).
  UPDATE content_gaps SET status = CASE WHEN outcome = 'verified' THEN 'verified' WHEN p_verdict = 'disagree' THEN 'open' ELSE 'held' END,
         fix_id = CASE WHEN outcome <> 'verified' AND p_verdict = 'disagree' THEN NULL ELSE fix_id END,
         revision = revision + 1, updated_at = now()
  WHERE id = ANY(f.gap_ids) AND fix_id = p_fix_id AND status = 'proposed';
  RETURN jsonb_build_object('fixId', p_fix_id, 'status', outcome, 'checks', checks);
END;
$$;

UPDATE hq.members SET instructions = instructions || $t$

TENABLE BOARD (context.slots / context.people). slots = the board's answers in order: {rank, id, name, value, unit}. people = who the matcher took the typed text for: {id, name, onList}. Decide from them:
   - correct: the person is real but not on slots (onList false) and the board is right without them. Most misses are.
   - alias: the typed text is a spelling of someone on slots that we do not accept (onList true, or verdict unknown and you can name the slot). payload {entityId: the slot id, locale, text: exactly what was typed}.
   - wontfix with reason "question wrong: board …": the board itself is wrong or out of date (a missing or wrong answer, read against context.note). Say which and cite it: Romero sends it on.$t$,
  updated_at = now()
 WHERE slug = 'answer-gap-monitor' AND instructions NOT LIKE '%TENABLE BOARD (context.slots%';

UPDATE hq.members SET instructions = instructions || $v$

SOURCES AND CUT-OFFS. Wikipedia in any language, Wikidata and Wikipedia mirrors count as ONE publisher. Every verification needs two: for an alias add an independent site (transfermarkt, espn, the club's or league's own site, worldfootball, fbref, soccerway…) that writes the name that way. For stats, extracted = {pid, asOf, leagues}: asOf is the date you confirmed the totals run through; it must be the claim's cut-off (a call without asOf is refused).$v$,
  updated_at = now()
 WHERE slug = 'content-verifier' AND instructions NOT LIKE '%SOURCES AND CUT-OFFS.%';

-- Tenable gaps a run holds now were claimed with the old context: back to the queue at once, attempts as they were.
-- The first update is the usual give-back (the trigger counts a try); the second restores the gap (open to open does
-- not fire the trigger).
-- The rows are locked while their state is read and stay locked to commit, so a Fixer deciding one of them meanwhile
-- waits, then finds the lease gone (its proposal or closure is refused, nothing is overwritten). Each update also
-- matches the lease it read.
CREATE TEMP TABLE content_fixer_tv_leased ON COMMIT DROP AS
  SELECT id, lease_token, attempts, audit FROM content_gaps WHERE game = 'tenable' AND status = 'checking' FOR UPDATE;
UPDATE content_gaps g SET status = 'open', revision = g.revision + 1, updated_at = now()
  FROM content_fixer_tv_leased l WHERE g.id = l.id AND g.status = 'checking' AND g.lease_token IS NOT DISTINCT FROM l.lease_token;
UPDATE content_gaps g SET status = 'open', attempts = l.attempts, next_try_at = NULL, audit = l.audit, updated_at = now()
  FROM content_fixer_tv_leased l WHERE g.id = l.id AND g.lease_owner IS NULL AND g.attempts = l.attempts + 1;
