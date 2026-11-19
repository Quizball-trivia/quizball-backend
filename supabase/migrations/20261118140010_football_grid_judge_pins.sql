-- A match pins the shared judge version it was created with (NULL: judged by its board's frozen answer list, as
-- before). Nullable columns without defaults and NOT VALID foreign keys: no table rewrite and no scan under the lock;
-- 20261118140020 validates them with a weaker lock.
-- ADD COLUMN holds ACCESS EXCLUSIVE until this file commits: every statement here is catalog-only and short.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '5s';

ALTER TABLE public.football_grid_matches ADD COLUMN IF NOT EXISTS judge_version_id uuid;
ALTER TABLE public.football_grid_matches
  ADD CONSTRAINT football_grid_matches_judge_version_fk
  FOREIGN KEY (judge_version_id) REFERENCES public.football_grid_judge_versions(id) ON DELETE RESTRICT NOT VALID;

-- A versioned claim names the version's alias here; accepted_alias_id keeps referencing release aliases only.
ALTER TABLE public.football_grid_claims ADD COLUMN IF NOT EXISTS accepted_judge_alias_id uuid;
ALTER TABLE public.football_grid_claims
  ADD CONSTRAINT football_grid_claims_judge_alias_fk
  FOREIGN KEY (accepted_judge_alias_id) REFERENCES public.football_grid_judge_aliases(id) ON DELETE RESTRICT NOT VALID;

-- Same turn and actor checks as before. The answer check has two paths: a legacy match accepts what its board's
-- answer list holds; a versioned match accepts a footballer who meets both of the cell's criteria under its version.
CREATE OR REPLACE FUNCTION public.football_grid_validate_claim()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  persisted_turn integer;
  next_actor uuid;
  persisted_phase text;
  pinned_version uuid;
BEGIN
  SELECT gm.turn_number, gm.current_player_user_id, gm.phase, gm.judge_version_id
    INTO persisted_turn, next_actor, persisted_phase, pinned_version
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
  IF pinned_version IS NULL THEN
    IF NEW.accepted_judge_alias_id IS NOT NULL THEN
      RAISE EXCEPTION 'a legacy football grid claim cannot name a judge version alias';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.football_grid_matches gm
        JOIN public.football_grid_board_answers a
          ON a.board_id = gm.board_id
         AND a.cell_index = NEW.cell_index
         AND a.football_player_id = NEW.football_player_id
       WHERE gm.match_id = NEW.match_id
    ) THEN
      RAISE EXCEPTION 'football grid claim is not valid for the pinned board cell';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.football_grid_judge_versions v
     WHERE v.id = pinned_version AND v.status IN ('ready', 'active')
  ) THEN
    RAISE EXCEPTION 'football grid claim judge version is not servable';
  END IF;
  IF NEW.accepted_alias_id IS NOT NULL THEN
    RAISE EXCEPTION 'a versioned football grid claim cannot name a release alias';
  END IF;
  IF NEW.accepted_judge_alias_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.football_grid_judge_aliases al
     WHERE al.id = NEW.accepted_judge_alias_id
       AND al.judge_version_id = pinned_version
       AND al.football_player_id = NEW.football_player_id
  ) THEN
    RAISE EXCEPTION 'football grid claim alias is not in the pinned judge version';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.football_grid_matches gm
      JOIN public.football_grid_boards b ON b.id = gm.board_id
      JOIN public.football_grid_criterion_bindings rb
        ON rb.judge_version_id = pinned_version
       AND rb.criterion_id = b.row_criteria[NEW.cell_index / 3 + 1]
       AND rb.status = 'bound'
      JOIN public.football_grid_criterion_bindings cb
        ON cb.judge_version_id = pinned_version
       AND cb.criterion_id = b.column_criteria[NEW.cell_index % 3 + 1]
       AND cb.status = 'bound'
      JOIN public.football_grid_criterion_players rp
        ON rp.judge_version_id = pinned_version
       AND rp.definition_id = rb.definition_id
       AND rp.football_player_id = NEW.football_player_id
      JOIN public.football_grid_criterion_players cp
        ON cp.judge_version_id = pinned_version
       AND cp.definition_id = cb.definition_id
       AND cp.football_player_id = NEW.football_player_id
     WHERE gm.match_id = NEW.match_id
  ) THEN
    RAISE EXCEPTION 'football grid claim is not valid for the cell under the pinned judge version';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.football_grid_validate_claim() FROM PUBLIC, anon, authenticated;
