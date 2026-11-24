-- Duplicate records of one footballer folded in a judge version (stub -> canonical record). The version judges only
-- the canonical record; this map lets ids recorded before the fold (legacy claims, picks) be read as that record.
-- Written while the version builds, immutable after, server-only like the other judge tables.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.football_grid_judge_player_identities (
  judge_version_id uuid NOT NULL REFERENCES public.football_grid_judge_versions(id) ON DELETE RESTRICT,
  stub_player_id uuid NOT NULL REFERENCES public.football_players(id) ON DELETE RESTRICT,
  canonical_player_id uuid NOT NULL REFERENCES public.football_players(id) ON DELETE RESTRICT,
  PRIMARY KEY (judge_version_id, stub_player_id),
  CHECK (stub_player_id <> canonical_player_id)
);

CREATE TRIGGER football_grid_judge_player_identities_guard BEFORE INSERT OR UPDATE OR DELETE ON public.football_grid_judge_player_identities
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_judge_content_guard();

ALTER TABLE public.football_grid_judge_player_identities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.football_grid_judge_player_identities FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.football_grid_judge_player_identities TO service_role;
REVOKE TRUNCATE ON public.football_grid_judge_player_identities FROM PUBLIC, anon, authenticated, service_role;
