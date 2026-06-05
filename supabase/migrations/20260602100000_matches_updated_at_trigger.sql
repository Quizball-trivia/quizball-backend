-- The matches.updated_at column was added with a DEFAULT now() but no trigger,
-- so it was only set at INSERT and never refreshed on UPDATE. The stale-match
-- sweeper relies on updated_at to mean "last activity"; without this trigger a
-- live, progressing match keeps its creation-time updated_at and could be swept
-- mid-game. Attach the existing trigger_set_updated_at() so every UPDATE bumps it.
DROP TRIGGER IF EXISTS trg_matches_set_updated_at ON public.matches;
CREATE TRIGGER trg_matches_set_updated_at
  BEFORE UPDATE ON public.matches
  FOR EACH ROW
  EXECUTE FUNCTION trigger_set_updated_at();

-- The stale-match sweeper reads the oldest active matches whose updated_at has
-- gone quiet. Index that exact access pattern so the 5-minute sweep stays cheap
-- even when the matches table grows large.
CREATE INDEX IF NOT EXISTS matches_active_updated_at_idx
  ON public.matches (updated_at ASC)
  WHERE status = 'active';
