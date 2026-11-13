-- The Content Fixer also works Football Grid: multiplayer Grid now records refused names (game football_grid, next to
-- grid_daily), the gap context gives a cell's two criteria and, per person, which of them a published release already
-- holds; a Grid membership (a cited fact the cell lacks) and a Grid alias can be verified by the Content Verifier and
-- reach the game through a reviewed correction release. Darts and Tenable unchanged.

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
    RETURN jsonb_build_object('game', p_game, 'board', p_board, 'found', true, 'contentHash', md5(cat::text),
                              'recorded', p_recorded,
                              'stale', p_recorded IS NOT NULL AND NOT starts_with(p_recorded, (cat->>'kind') || '|' || (cat->>'release') || '|'),
                              'title', cat->'title'->>'en', 'kind', cat->>'kind', 'release', cat->>'release', 'asOf', cat->>'asOf',
                              'people', to_jsonb(people));
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
    -- The facts a fix would change (memberships, the cell's list, newer releases): a publish in between moves the hash.
    RETURN out || jsonb_build_object('contentHash', md5((out - 'recorded')::text));
  END IF;
  RETURN jsonb_build_object('game', p_game, 'board', p_board, 'found', false, 'people', to_jsonb(people));
END;
$$;

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
    UPDATE content_gaps SET status = p_kind, lease_owner = NULL, lease_token = NULL, lease_until = NULL, revision = revision + 1, updated_at = now()
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
      IF EXISTS (SELECT 1 FROM content_gaps WHERE id = ANY(p_gap_ids) AND norm IS DISTINCT FROM hq.answer_gaps_norm(p_payload->>'text')) THEN
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

UPDATE hq.members SET instructions = instructions || $g$

FOOTBALL GRID (games football_grid and grid_daily). A cell is two criteria (a club, country, league, manager, teammate, trophy…); a footballer is right for it when he meets BOTH. The context gives rowKey/rowLabel, columnKey/columnLabel and, per person the matcher read the answer as, inRow / inColumn (the target release, the newest published one holding both criteria, already has that fact; a footballer is right for a cell only when one release has both) and onBoard (the cell's own answer list has him).
   - membership (Grid): he really meets the criterion or criteria we lack. payload {pid, criterionKeys, fact}: pid from context.people; criterionKeys = exactly the cell keys where he is false (one or both); fact = one sentence with the spell and years (e.g. "Played for <club> 2003-2005, 41 league games"). Evidence must state that fact. On Grid a membership is checked by the Content Verifier, not a person.
   - inRow and inColumn both true: the fact is already published; close wontfix "already published".
   - alias (Grid): the person is already right for this cell but his spelling was not read (people empty or a different person). entityId = his footballer id; only when you know it from the context.
   - "unknown" with no people: propose needs_entity (with who you think it is and why) unless it is junk.
   - Never a membership on a stretch. What each criterion means: club = at least one senior appearance for that club (loans count; youth/reserve teams do not); league = a senior appearance in that league; manager = he played in a team that manager coached at the same time; teammate = same club in the same season; country = his nationality; trophy = he appeared in the winning campaign; born-/position- wildcards = birth decade / main position.$g$,
       updated_at = now()
 WHERE slug = 'answer-gap-monitor' AND instructions NOT LIKE '%FOOTBALL GRID (games football_grid%';

UPDATE hq.members SET instructions = instructions || $g$

FOOTBALL GRID memberships: the claim is {pid, criterionKeys, fact} and the context names each key (rowKey/rowLabel, columnKey/columnLabel). Establish yourself, from two publishers, whether that footballer meets every listed criterion (club = a senior appearance for it, loans count, youth/reserve teams do not; league = a senior appearance in it; manager = he played in a team that manager coached at the same time; teammate = same club in the same season; country = his nationality; trophy = he appeared in the winning campaign). extracted = {pid, criterionKeys: the keys you confirmed}. Agree only when you confirmed every listed key. Grid aliases: as for any alias.$g$,
       updated_at = now()
 WHERE slug = 'content-verifier' AND instructions NOT LIKE '%FOOTBALL GRID memberships%';
