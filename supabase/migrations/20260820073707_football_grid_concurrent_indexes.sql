-- migrate:no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS matches_active_game_variant_idx
  ON public.matches (game_variant, updated_at DESC)
  WHERE status = 'active';
