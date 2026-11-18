-- Football Grid shared judge: who satisfies a criterion is decided by one versioned eligibility store shared by every
-- board, instead of the answer list each release froze into its boards. A judge version is built once (status
-- building), then never changes; a match or run pins the version it started with. New tables only, no content: the
-- builder (scripts/football-grid-judge-build.ts) loads each environment from private files. Server-only data: RLS on,
-- no grants to client roles, so nothing here is reachable through the Data API.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public.football_grid_judge_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL UNIQUE CHECK (label ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  status text NOT NULL DEFAULT 'building' CHECK (status IN ('building', 'ready', 'active', 'revoked')),
  source jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source) = 'object'),
  checksums jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checksums) = 'object'),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(counts) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  activated_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  CHECK (status = 'building' OR ready_at IS NOT NULL),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX football_grid_judge_versions_one_active
  ON public.football_grid_judge_versions ((true)) WHERE status = 'active';

-- What a criterion means, independent of any release: family, subtype, the entity it names and the rule (predicate).
CREATE TABLE public.football_grid_criterion_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_key text NOT NULL UNIQUE CHECK (length(definition_key) BETWEEN 3 AND 300),
  family text NOT NULL,
  subtype text NOT NULL,
  entity_ref text NOT NULL CHECK (length(entity_ref) BETWEEN 1 AND 200),
  semantic_version integer NOT NULL CHECK (semantic_version > 0),
  predicate text NOT NULL CHECK (length(predicate) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Per version, which definition each release criterion row means. A row the builder cannot prove equivalent is
-- 'ambiguous' (no definition): boards using it are never judged by this version.
CREATE TABLE public.football_grid_criterion_bindings (
  judge_version_id uuid NOT NULL REFERENCES public.football_grid_judge_versions(id) ON DELETE RESTRICT,
  criterion_id uuid NOT NULL REFERENCES public.football_grid_criteria(id) ON DELETE RESTRICT,
  definition_id uuid REFERENCES public.football_grid_criterion_definitions(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('bound', 'ambiguous')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 300),
  PRIMARY KEY (judge_version_id, criterion_id),
  CHECK ((status = 'bound') = (definition_id IS NOT NULL))
);

CREATE TABLE public.football_grid_criterion_players (
  judge_version_id uuid NOT NULL REFERENCES public.football_grid_judge_versions(id) ON DELETE RESTRICT,
  definition_id uuid NOT NULL REFERENCES public.football_grid_criterion_definitions(id) ON DELETE RESTRICT,
  football_player_id uuid NOT NULL REFERENCES public.football_players(id) ON DELETE RESTRICT,
  -- The first proof the builder found: m:<release version> (a reviewed release membership) or f:<fact id>.
  proof_ref text NOT NULL CHECK (length(proof_ref) BETWEEN 3 AND 120),
  PRIMARY KEY (judge_version_id, definition_id, football_player_id)
);

-- Every footballer the version can credit: frozen rank (shared-name order) and the names name forms are built from.
CREATE TABLE public.football_grid_judge_players (
  judge_version_id uuid NOT NULL REFERENCES public.football_grid_judge_versions(id) ON DELETE RESTRICT,
  football_player_id uuid NOT NULL REFERENCES public.football_players(id) ON DELETE RESTRICT,
  rank_score numeric NOT NULL DEFAULT 0,
  name_en text NOT NULL CHECK (length(name_en) BETWEEN 1 AND 160),
  name_ka text CHECK (name_ka IS NULL OR length(name_ka) BETWEEN 1 AND 160),
  name_ru text CHECK (name_ru IS NULL OR length(name_ru) BETWEEN 1 AND 160),
  name_el text CHECK (name_el IS NULL OR length(name_el) BETWEEN 1 AND 160),
  PRIMARY KEY (judge_version_id, football_player_id)
);

CREATE TABLE public.football_grid_judge_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  judge_version_id uuid NOT NULL REFERENCES public.football_grid_judge_versions(id) ON DELETE RESTRICT,
  football_player_id uuid NOT NULL REFERENCES public.football_players(id) ON DELETE RESTRICT,
  alias text NOT NULL CHECK (length(alias) BETWEEN 1 AND 160),
  normalized_alias text NOT NULL CHECK (length(normalized_alias) BETWEEN 1 AND 160),
  locale text NOT NULL CHECK (locale IN ('en', 'ka', 'translit', 'es', 'tr', 'ru', 'pt', 'de', 'fr', 'el')),
  alias_type text NOT NULL CHECK (length(alias_type) BETWEEN 1 AND 40),
  acceptance_policy text NOT NULL CHECK (acceptance_policy IN ('exact', 'unique_only', 'safe_typo')),
  source_ref text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 120),
  UNIQUE (judge_version_id, football_player_id, normalized_alias, locale, acceptance_policy)
);
CREATE INDEX football_grid_judge_aliases_version_idx
  ON public.football_grid_judge_aliases (judge_version_id, football_player_id);

-- The typo-veto universe (every footballer's name), frozen with the version so a verdict never depends on a refresh.
CREATE TABLE public.football_grid_judge_namesakes (
  judge_version_id uuid NOT NULL REFERENCES public.football_grid_judge_versions(id) ON DELETE RESTRICT,
  football_player_id uuid NOT NULL REFERENCES public.football_players(id) ON DELETE RESTRICT,
  normalized_name text NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 200),
  PRIMARY KEY (judge_version_id, football_player_id, normalized_name)
);

CREATE TABLE public.football_grid_board_certifications (
  judge_version_id uuid NOT NULL REFERENCES public.football_grid_judge_versions(id) ON DELETE RESTRICT,
  board_id uuid NOT NULL REFERENCES public.football_grid_boards(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('certified', 'rejected', 'unbound')),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object'),
  PRIMARY KEY (judge_version_id, board_id)
);

-- Which new matches and runs get the active version. Rollback is setting the percentages back to 0.
CREATE TABLE public.football_grid_judge_rollout (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  online_percent smallint NOT NULL DEFAULT 0 CHECK (online_percent BETWEEN 0 AND 100),
  solo_percent smallint NOT NULL DEFAULT 0 CHECK (solo_percent BETWEEN 0 AND 100),
  daily_percent smallint NOT NULL DEFAULT 0 CHECK (daily_percent BETWEEN 0 AND 100),
  shadow_percent smallint NOT NULL DEFAULT 0 CHECK (shadow_percent BETWEEN 0 AND 100),
  updated_by text NOT NULL DEFAULT 'migration',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.football_grid_judge_rollout (id) VALUES (1) ON CONFLICT DO NOTHING;

-- A legacy attempt judged again by the shared judge on the same pre-attempt state. Never affects the verdict.
CREATE TABLE public.football_grid_shadow_verdicts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_inbox_id uuid NOT NULL UNIQUE,
  match_id uuid NOT NULL,
  judge_version_id uuid NOT NULL REFERENCES public.football_grid_judge_versions(id) ON DELETE RESTRICT,
  board_id uuid NOT NULL,
  cell_index smallint NOT NULL CHECK (cell_index BETWEEN 0 AND 8),
  answer_kind text NOT NULL CHECK (answer_kind IN ('typed', 'picked')),
  certified boolean NOT NULL,
  legacy_outcome text NOT NULL,
  legacy_player_id uuid,
  legacy_reason text NOT NULL,
  -- 'error': the shared judge could not judge it (unbound board, unavailable version); counted, never dropped.
  shadow_outcome text NOT NULL,
  shadow_player_id uuid,
  shadow_reason text NOT NULL,
  legacy_checksum text NOT NULL,
  shadow_checksum text NOT NULL,
  used_player_ids uuid[] NOT NULL DEFAULT '{}',
  latency_ms numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX football_grid_shadow_verdicts_diff_idx
  ON public.football_grid_shadow_verdicts (created_at)
  WHERE legacy_outcome IS DISTINCT FROM shadow_outcome OR legacy_player_id IS DISTINCT FROM shadow_player_id;

-- A version's content is written while it is building and never after. The writer holds a share lock on the version
-- row until it commits; sealing (building -> ready) updates that row, so it waits for every open writer, and a writer
-- that comes later sees the sealed status.
CREATE OR REPLACE FUNCTION public.football_grid_judge_content_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  version_status text;
BEGIN
  SELECT status INTO version_status FROM public.football_grid_judge_versions
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.judge_version_id ELSE NEW.judge_version_id END
   FOR SHARE;
  IF version_status IS DISTINCT FROM 'building' THEN
    RAISE EXCEPTION 'football grid judge version content is immutable once built';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.judge_version_id <> OLD.judge_version_id THEN
    RAISE EXCEPTION 'football grid judge content cannot move between versions';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER football_grid_criterion_bindings_guard BEFORE INSERT OR UPDATE OR DELETE ON public.football_grid_criterion_bindings
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_judge_content_guard();
CREATE TRIGGER football_grid_criterion_players_guard BEFORE INSERT OR UPDATE OR DELETE ON public.football_grid_criterion_players
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_judge_content_guard();
CREATE TRIGGER football_grid_judge_players_guard BEFORE INSERT OR UPDATE OR DELETE ON public.football_grid_judge_players
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_judge_content_guard();
CREATE TRIGGER football_grid_judge_aliases_guard BEFORE INSERT OR UPDATE OR DELETE ON public.football_grid_judge_aliases
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_judge_content_guard();
CREATE TRIGGER football_grid_judge_namesakes_guard BEFORE INSERT OR UPDATE OR DELETE ON public.football_grid_judge_namesakes
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_judge_content_guard();
CREATE TRIGGER football_grid_board_certifications_guard BEFORE INSERT OR UPDATE OR DELETE ON public.football_grid_board_certifications
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_judge_content_guard();

-- building -> ready -> active <-> ready; any built version -> revoked (final). Identity and source never change.
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
  IF OLD.status <> 'building' AND (NEW.source <> OLD.source OR NEW.checksums <> OLD.checksums OR NEW.counts <> OLD.counts) THEN
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

CREATE TRIGGER football_grid_judge_versions_guard BEFORE UPDATE OR DELETE ON public.football_grid_judge_versions
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_judge_version_guard();

CREATE OR REPLACE FUNCTION public.football_grid_reject_definition_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'football grid criterion definitions are immutable';
END;
$$;

CREATE TRIGGER football_grid_criterion_definitions_immutable BEFORE UPDATE OR DELETE ON public.football_grid_criterion_definitions
  FOR EACH ROW EXECUTE FUNCTION public.football_grid_reject_definition_change();

ALTER TABLE public.football_grid_judge_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_criterion_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_criterion_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_criterion_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_judge_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_judge_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_judge_namesakes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_board_certifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_judge_rollout ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_shadow_verdicts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON
  public.football_grid_judge_versions,
  public.football_grid_criterion_definitions,
  public.football_grid_criterion_bindings,
  public.football_grid_criterion_players,
  public.football_grid_judge_players,
  public.football_grid_judge_aliases,
  public.football_grid_judge_namesakes,
  public.football_grid_board_certifications,
  public.football_grid_judge_rollout,
  public.football_grid_shadow_verdicts
FROM PUBLIC, anon, authenticated;
GRANT ALL ON
  public.football_grid_judge_versions,
  public.football_grid_criterion_definitions,
  public.football_grid_criterion_bindings,
  public.football_grid_criterion_players,
  public.football_grid_judge_players,
  public.football_grid_judge_aliases,
  public.football_grid_judge_namesakes,
  public.football_grid_board_certifications,
  public.football_grid_judge_rollout,
  public.football_grid_shadow_verdicts
TO service_role;

REVOKE EXECUTE ON FUNCTION
  public.football_grid_judge_content_guard(),
  public.football_grid_judge_version_guard(),
  public.football_grid_reject_definition_change()
FROM PUBLIC, anon, authenticated;
