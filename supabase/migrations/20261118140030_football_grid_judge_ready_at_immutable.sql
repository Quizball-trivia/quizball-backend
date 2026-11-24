-- A built judge version's ready_at is fixed: the runtime orders a version's cells by the board hints published
-- before it (football-grid-eligibility.repo.ts getBoardCells), so moving it would reorder a sealed version.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

CREATE OR REPLACE FUNCTION public.football_grid_judge_version_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'building' THEN
      RAISE EXCEPTION 'a built football grid judge version cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id <> OLD.id OR NEW.label <> OLD.label OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'football grid judge version identity is immutable';
  END IF;
  -- ready_at also orders a version's cells (board hints published before it): fixed once built.
  IF OLD.status <> 'building' AND (NEW.source <> OLD.source OR NEW.checksums <> OLD.checksums OR NEW.counts <> OLD.counts
                                    OR NEW.ready_at IS DISTINCT FROM OLD.ready_at) THEN
    RAISE EXCEPTION 'a built football grid judge version is immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'building' AND NEW.status = 'ready')
    OR (OLD.status = 'ready' AND NEW.status IN ('active', 'revoked'))
    OR (OLD.status = 'active' AND NEW.status IN ('ready', 'revoked'))
  ) THEN
    RAISE EXCEPTION 'invalid football grid judge version transition % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'revoked' THEN
    RAISE EXCEPTION 'a revoked football grid judge version is final';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.football_grid_judge_version_guard() FROM PUBLIC, anon, authenticated;
