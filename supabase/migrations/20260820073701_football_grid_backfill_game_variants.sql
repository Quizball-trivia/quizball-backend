-- migrate:no-transaction
-- The procedure commits each 1,000-row batch. It must be invoked at top level,
-- outside the per-migration transaction used for ordinary schema changes.
CALL public.football_grid_backfill_game_variants(1000);
