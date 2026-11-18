-- An online or bot match judges typed answers against its board plus what the releases published when it started
-- hold in both clues of a cell (football-grid-carried-answers.ts), as solo and the daily grid already do. Published
-- releases are immutable, so their ids are the frozen answer set: both players, and every replica after a reconnect,
-- are judged by the same answers even if a release is published or retired mid-match. NULL (matches created before
-- this column) judges by the board alone, as before. A nullable column without a default is a catalog-only change.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.football_grid_matches
  ADD COLUMN IF NOT EXISTS carried_release_ids uuid[];

-- A claim is valid for the pinned board cell, or for a footballer one of the match's frozen releases holds in both
-- clues of that cell.
CREATE OR REPLACE FUNCTION public.football_grid_validate_claim()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  persisted_turn integer;
  next_actor uuid;
  persisted_phase text;
BEGIN
  SELECT gm.turn_number, gm.current_player_user_id, gm.phase
    INTO persisted_turn, next_actor, persisted_phase
    FROM public.football_grid_matches gm
   WHERE gm.match_id = NEW.match_id;
  IF persisted_turn IS NULL OR (
    (persisted_phase = 'terminal' AND NEW.turn_number <> persisted_turn)
    OR (persisted_phase <> 'terminal' AND NEW.turn_number <> persisted_turn - 1)
  ) THEN
    RAISE EXCEPTION 'football grid claim has an invalid turn';
  END IF;
  IF next_actor IS NOT NULL AND next_actor = NEW.claimant_user_id THEN
    RAISE EXCEPTION 'football grid claim actor does not own the resolved turn';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.football_grid_matches gm
      JOIN public.football_grid_board_answers a
        ON a.board_id = gm.board_id
       AND a.cell_index = NEW.cell_index
       AND a.football_player_id = NEW.football_player_id
     WHERE gm.match_id = NEW.match_id
  ) AND NOT EXISTS (
    SELECT 1
      FROM public.football_grid_matches gm
      JOIN public.football_grid_boards b ON b.id = gm.board_id
      JOIN public.football_grid_criteria brc ON brc.id = b.row_criteria[NEW.cell_index / 3 + 1]
      JOIN public.football_grid_criteria bcc ON bcc.id = b.column_criteria[NEW.cell_index % 3 + 1]
      JOIN public.football_grid_criteria rk
        ON rk.release_id = ANY(gm.carried_release_ids) AND rk.criterion_key = brc.criterion_key
      JOIN public.football_grid_criteria ck
        ON ck.release_id = rk.release_id AND ck.criterion_key = bcc.criterion_key
      JOIN public.football_grid_criterion_memberships mr
        ON mr.criterion_id = rk.id AND mr.football_player_id = NEW.football_player_id
      JOIN public.football_grid_criterion_memberships mc
        ON mc.criterion_id = ck.id AND mc.football_player_id = NEW.football_player_id
     WHERE gm.match_id = NEW.match_id
  ) THEN
    RAISE EXCEPTION 'football grid claim is not valid for the pinned board cell';
  END IF;
  RETURN NEW;
END;
$$;
