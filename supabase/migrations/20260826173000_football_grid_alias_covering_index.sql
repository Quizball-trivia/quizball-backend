-- migrate:no-transaction
-- Answer resolution reads every accepted alias for the players on one board.
-- The existing lookup index still requires hundreds of random heap fetches per
-- cold board.  Cover the resolver projection so concurrent match starts can use
-- an index-only scan instead of saturating the shared database pool.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_football_grid_aliases_player_covering
  ON public.football_grid_player_aliases (release_id, football_player_id)
  INCLUDE (id, alias, normalized_alias, locale, acceptance_policy);
