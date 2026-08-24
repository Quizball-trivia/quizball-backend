SET LOCAL lock_timeout = '5s';

-- Validate after the ADD CONSTRAINT transaction has committed, so the table
-- scan does not run while that migration's ACCESS EXCLUSIVE lock is held.
ALTER TABLE public.lobbies VALIDATE CONSTRAINT lobbies_game_mode_check_v2;
ALTER TABLE public.lobbies DROP CONSTRAINT IF EXISTS lobbies_game_mode_check;
ALTER TABLE public.lobbies RENAME CONSTRAINT lobbies_game_mode_check_v2 TO lobbies_game_mode_check;

ALTER TABLE public.matches VALIDATE CONSTRAINT matches_game_variant_check;
ALTER TABLE public.matches VALIDATE CONSTRAINT matches_game_variant_not_null;
ALTER TABLE public.matches VALIDATE CONSTRAINT matches_mode_game_variant_check;

-- PostgreSQL can use the validated non-null CHECK as proof, avoiding another
-- full-table scan while it installs the native NOT NULL metadata flag.
ALTER TABLE public.matches ALTER COLUMN game_variant SET NOT NULL;
ALTER TABLE public.matches DROP CONSTRAINT matches_game_variant_not_null;

DROP PROCEDURE public.football_grid_backfill_game_variants(integer);
