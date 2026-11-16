-- Word games: a footballer may carry up to 24 aliases (was 16), mirrored by the release file schema.
-- The wider check is added NOT VALID and validated in the next migration, under a weaker lock.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.wordgame_players
  DROP CONSTRAINT IF EXISTS chk_wordgame_players_aliases,
  ADD CONSTRAINT chk_wordgame_players_aliases CHECK (cardinality(aliases) <= 24) NOT VALID;
