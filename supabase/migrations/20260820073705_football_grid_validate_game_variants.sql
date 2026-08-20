SET LOCAL lock_timeout = '5s';

ALTER TABLE public.matches VALIDATE CONSTRAINT matches_game_variant_check;
ALTER TABLE public.matches VALIDATE CONSTRAINT matches_game_variant_not_null;
ALTER TABLE public.matches VALIDATE CONSTRAINT matches_mode_game_variant_check;

-- PostgreSQL can use the validated non-null CHECK as proof, avoiding another
-- full-table scan while it installs the native NOT NULL metadata flag.
ALTER TABLE public.matches ALTER COLUMN game_variant SET NOT NULL;
ALTER TABLE public.matches DROP CONSTRAINT matches_game_variant_not_null;

DROP PROCEDURE public.football_grid_backfill_game_variants(integer);
