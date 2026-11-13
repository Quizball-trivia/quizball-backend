-- The Content Fixer sees Ranked: refused Who Am I and Countdown guesses are now recorded (games clue_chain and
-- countdown_list, keyed by question id), and the gap context gives the question and the answers it accepts now.
-- Context only: a Ranked fix still goes to Romero (nothing publishes question edits yet).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

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
  ELSIF p_game IN ('clue_chain', 'countdown_list') THEN
    -- Ranked: the board is the question. The Fixer reads the question in English and the answers it accepts now
    -- (Who Am I: display answer + accepted answers in every language; Countdown: the answer groups).
    IF p_board !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN jsonb_build_object('game', p_game, 'board', p_board, 'found', false);
    END IF;
    SELECT q.type, q.status, coalesce(q.prompt->>'en', q.prompt::text), qp.payload INTO v_qtype, v_qstatus, v_prompt, cat
      FROM questions q JOIN question_payloads qp ON qp.question_id = q.id
     WHERE q.id = p_board::uuid AND q.type = p_game
     ORDER BY qp.updated_at DESC LIMIT 1;
    IF cat IS NULL THEN RETURN jsonb_build_object('game', p_game, 'board', p_board, 'found', false); END IF;
    RETURN jsonb_build_object(
      'game', p_game, 'board', p_board, 'found', true, 'recorded', p_recorded, 'contentHash', md5(cat::text),
      'questionStatus', v_qstatus, 'prompt', left(v_prompt, 400),
      'clues', CASE WHEN p_game = 'clue_chain' THEN (SELECT jsonb_agg(coalesce(c->>'en', c::text)) FROM jsonb_array_elements(coalesce(cat->'clues', '[]'::jsonb)) c) END,
      'displayAnswer', cat->'display_answer',
      'acceptedAnswers', CASE WHEN p_game = 'clue_chain' THEN cat->'accepted_answers' END,
      'answerGroups', CASE WHEN p_game = 'countdown_list' THEN cat->'answer_groups' END);
  END IF;
  RETURN jsonb_build_object('game', p_game, 'board', p_board, 'found', false, 'people', to_jsonb(people));
END;
$$;

UPDATE hq.members SET instructions = instructions || $r$

RANKED (games clue_chain = Who Am I, countdown_list = Countdown). The board is a question; the context gives its prompt, its clues and the answers it accepts now (Who Am I: displayAnswer + acceptedAnswers per language; Countdown: answerGroups, each a right answer with the spellings it accepts). Decide:
   - correct: the guess is simply wrong for this question (another player, not on the list). Most refused guesses are.
   - accepted: the guess IS the answer (or one of the list's answers) written in a way we do not accept: a script form, a common spelling, a well-known short name. payload {text, answerOf: the accepted answer it means, locale}. Never for a different person, even a close one.
   - wontfix with reason "question wrong": the question itself is wrong (the answer we accept is not the right one, or a right answer is missing from a list). Say what is wrong and cite it: Romero sends it on.$r$,
  updated_at = now()
 WHERE slug = 'answer-gap-monitor' AND instructions NOT LIKE '%RANKED (games clue_chain%';
