-- =============================================================================
-- Migration: Card pipeline V2 schema contract
-- Source contract: quizball-auction-content/MIGRATION-REQUIREMENTS.sql
-- =============================================================================

-- Immutable source snapshots -------------------------------------------------

CREATE TABLE IF NOT EXISTS public.content_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  source_uri text,
  source_checksum text NOT NULL,
  parent_snapshot_id uuid REFERENCES public.content_snapshots(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'staging'
    CHECK (status IN ('staging', 'validated', 'promoted', 'rejected')),
  player_row_count integer NOT NULL DEFAULT 0 CHECK (player_row_count >= 0),
  valuation_row_count integer NOT NULL DEFAULT 0 CHECK (valuation_row_count >= 0),
  player_checksum text,
  valuation_checksum text,
  anomaly_report jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(anomaly_report) = 'object'),
  started_at timestamptz NOT NULL DEFAULT now(),
  validated_at timestamptz,
  promoted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_checksum)
);

CREATE INDEX IF NOT EXISTS idx_content_snapshots_source_created
  ON public.content_snapshots (source, created_at DESC);

CREATE TABLE IF NOT EXISTS public.content_snapshot_players (
  snapshot_id uuid NOT NULL REFERENCES public.content_snapshots(id) ON DELETE CASCADE,
  transfermarkt_id text NOT NULL,
  active_status text NOT NULL
    CHECK (active_status IN ('active', 'retired', 'unknown')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  row_checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, transfermarkt_id)
);

CREATE TABLE IF NOT EXISTS public.content_snapshot_valuations (
  snapshot_id uuid NOT NULL REFERENCES public.content_snapshots(id) ON DELETE CASCADE,
  transfermarkt_id text NOT NULL,
  valuation_date date NOT NULL,
  value_eur bigint NOT NULL CHECK (value_eur > 0),
  club_name text,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  row_checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_id, transfermarkt_id, valuation_date)
);

CREATE INDEX IF NOT EXISTS idx_content_snapshot_valuations_latest
  ON public.content_snapshot_valuations
  (snapshot_id, transfermarkt_id, valuation_date DESC);

ALTER TABLE public.football_players
  ADD COLUMN IF NOT EXISTS last_seen_snapshot_id uuid
    REFERENCES public.content_snapshots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS consecutive_snapshot_absences integer NOT NULL DEFAULT 0
    CHECK (consecutive_snapshot_absences >= 0);

ALTER TABLE public.football_player_market_values
  ADD COLUMN IF NOT EXISTS snapshot_id uuid
    REFERENCES public.content_snapshots(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_football_players_last_seen_snapshot
  ON public.football_players (last_seen_snapshot_id);

CREATE INDEX IF NOT EXISTS idx_football_player_market_values_snapshot
  ON public.football_player_market_values (snapshot_id);

-- Durable generation tasks and orchestration --------------------------------

CREATE TABLE IF NOT EXISTS public.card_pipeline_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_kind text NOT NULL CHECK (run_kind IN ('card_batch', 'monthly')),
  snapshot_id uuid REFERENCES public.content_snapshots(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed', 'stopped')),
  current_phase text,
  checkpoints jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(checkpoints) = 'object'),
  config jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(config) = 'object'),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(summary) = 'object'),
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.card_generation_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_run_id uuid REFERENCES public.card_pipeline_runs(id) ON DELETE SET NULL,
  snapshot_id uuid NOT NULL REFERENCES public.content_snapshots(id) ON DELETE RESTRICT,
  football_player_id uuid NOT NULL
    REFERENCES public.football_players(id) ON DELETE CASCADE,
  variant_key text NOT NULL CHECK (variant_key IN ('medium', 'hard')),
  target_difficulty text NOT NULL CHECK (target_difficulty IN ('medium', 'hard')),
  card_family_id uuid NOT NULL DEFAULT gen_random_uuid(),
  stage text NOT NULL DEFAULT 'queued'
    CHECK (
      stage IN (
        'queued', 'generated', 'verified', 'translated', 'ready',
        'published', 'rejected', 'failed'
      )
    ),
  is_canary boolean NOT NULL DEFAULT false,
  generated_payload jsonb CHECK (
    generated_payload IS NULL OR jsonb_typeof(generated_payload) = 'object'
  ),
  verified_payload jsonb CHECK (
    verified_payload IS NULL OR jsonb_typeof(verified_payload) = 'object'
  ),
  translated_payload jsonb CHECK (
    translated_payload IS NULL OR jsonb_typeof(translated_payload) = 'object'
  ),
  final_judge_payload jsonb CHECK (
    final_judge_payload IS NULL OR jsonb_typeof(final_judge_payload) = 'object'
  ),
  rejection_reason text,
  failure_class text,
  failure_message text,
  external_call_count integer NOT NULL DEFAULT 0 CHECK (external_call_count >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (snapshot_id, football_player_id, variant_key),
  UNIQUE (card_family_id)
);

CREATE INDEX IF NOT EXISTS idx_card_generation_tasks_claim
  ON public.card_generation_tasks (snapshot_id, stage, lease_expires_at, created_at);

CREATE INDEX IF NOT EXISTS idx_card_generation_tasks_player
  ON public.card_generation_tasks (football_player_id, variant_key);

CREATE TABLE IF NOT EXISTS public.card_generation_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.card_generation_tasks(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  task_stage text NOT NULL,
  external_call text,
  status text NOT NULL CHECK (status IN ('success', 'rejected', 'failed')),
  error_class text,
  error_message text,
  request_payload jsonb CHECK (
    request_payload IS NULL OR jsonb_typeof(request_payload) = 'object'
  ),
  response_payload jsonb CHECK (
    response_payload IS NULL OR jsonb_typeof(response_payload) = 'object'
  ),
  tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(tool_calls) = 'array'),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS public.card_pipeline_controls (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  generation_enabled boolean NOT NULL DEFAULT true,
  disabled_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.card_pipeline_controls (singleton, generation_enabled)
VALUES (true, true)
ON CONFLICT (singleton) DO NOTHING;

-- Card-family identity and lifecycle -----------------------------------------

ALTER TABLE public.player_clue_cards
  ADD COLUMN IF NOT EXISTS card_family_id uuid,
  ADD COLUMN IF NOT EXISTS variant_key text
    CHECK (variant_key IN ('medium', 'hard')),
  ADD COLUMN IF NOT EXISTS target_difficulty text
    CHECK (target_difficulty IN ('medium', 'hard')),
  ADD COLUMN IF NOT EXISTS snapshot_id uuid
    REFERENCES public.content_snapshots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS generation_task_id uuid
    REFERENCES public.card_generation_tasks(id) ON DELETE SET NULL;

-- Legacy locale rows cannot be paired reliably: preserve them as one family
-- per existing card and leave variant_key NULL. CMS code has an explicit
-- football_player_id fallback for these legacy rows.
UPDATE public.player_clue_cards
SET card_family_id = gen_random_uuid()
WHERE card_family_id IS NULL;

ALTER TABLE public.player_clue_cards
  DROP CONSTRAINT IF EXISTS player_clue_cards_status_check;

ALTER TABLE public.player_clue_cards
  ADD CONSTRAINT player_clue_cards_status_check
  CHECK (
    status IN (
      'draft', 'needs_review', 'approved', 'published', 'rejected',
      'superseded', 'archived'
    )
  );

DROP INDEX IF EXISTS public.idx_player_clue_cards_player_locale_prompt_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_clue_cards_family_locale_unique
  ON public.player_clue_cards (card_family_id, locale)
  WHERE card_family_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_clue_cards_current_variant_locale
  ON public.player_clue_cards (football_player_id, variant_key, locale)
  WHERE status = 'published' AND variant_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_player_clue_cards_player_variant_status
  ON public.player_clue_cards (football_player_id, variant_key, status);

CREATE OR REPLACE FUNCTION public.prevent_card_family_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.card_family_id IS NOT NULL
     AND (
       NEW.card_family_id IS DISTINCT FROM OLD.card_family_id
       OR NEW.football_player_id IS DISTINCT FROM OLD.football_player_id
       OR NEW.variant_key IS DISTINCT FROM OLD.variant_key
       OR NEW.locale IS DISTINCT FROM OLD.locale
     )
  THEN
    RAISE EXCEPTION 'player_clue_cards family identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_player_clue_cards_immutable_family
  ON public.player_clue_cards;
CREATE TRIGGER trg_player_clue_cards_immutable_family
  BEFORE UPDATE ON public.player_clue_cards
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_card_family_identity_change();

-- Preserve the exact column order of the current view from
-- 20260722210000_auction_active_only.sql. Only the starting-price hash key
-- changes from clue-card id to football-player id.
CREATE OR REPLACE VIEW public.player_clue_card_content_view AS
SELECT
  pcc.id AS clue_card_id,
  pcc.football_player_id,
  COALESCE(pcc.transfermarkt_id, pcgc.transfermarkt_id) AS transfermarkt_id,
  fp.name,
  fp.image_url,
  fp.position_group,
  COALESCE(
    pcgc.position_label_en,
    CASE fp.position_group
      WHEN 'GK' THEN 'Goalkeeper'
      WHEN 'DEF' THEN 'Defender'
      WHEN 'MID' THEN 'Midfielder'
      WHEN 'FWD' THEN 'Forward'
      ELSE NULL::text
    END
  ) AS position_label_en,
  COALESCE(
    pcgc.position_label_ka,
    CASE fp.position_group
      WHEN 'GK' THEN 'მეკარე'
      WHEN 'DEF' THEN 'მცველი'
      WHEN 'MID' THEN 'ნახევარმცველი'
      WHEN 'FWD' THEN 'ფორვარდი'
      ELSE NULL::text
    END
  ) AS position_label_ka,
  fp.current_club,
  fp.nationality,
  COALESCE(pcgc.current_value_eur, fp.current_value_eur) AS current_value_eur,
  COALESCE(pcgc.peak_value_eur, fp.peak_value_eur) AS peak_value_eur,
  pcc.locale,
  pcc.clue_1,
  pcc.clue_2,
  pcc.clue_3,
  pcc.difficulty,
  pcc.status,
  pcc.source,
  pcc.generation_provider,
  pcc.generation_model,
  pcc.prompt_version,
  pcc.evidence,
  pcc.review_notes,
  pcc.created_at,
  pcc.updated_at,
  COALESCE(app.auction_price_eur, pcgc.auction_price_eur, fp.current_value_eur) AS auction_price_eur,
  (ARRAY[10000000, 20000000, 30000000, 40000000, 50000000]::bigint[])[
    (((('x' || substr(md5(pcc.football_player_id::text), 1, 8))::bit(32)::bigint % 5) + 5) % 5) + 1
  ] AS starting_price_eur,
  fp.active_status
FROM public.player_clue_cards pcc
JOIN public.football_players fp
  ON fp.id = pcc.football_player_id
LEFT JOIN public.player_clue_generation_candidates pcgc
  ON pcgc.football_player_id = pcc.football_player_id
LEFT JOIN public.auction_player_pricing app
  ON app.football_player_id = pcc.football_player_id;

-- Existing updated_at trigger function is provided by backend-node migrations.
DROP TRIGGER IF EXISTS trg_content_snapshots_set_updated_at ON public.content_snapshots;
CREATE TRIGGER trg_content_snapshots_set_updated_at
  BEFORE UPDATE ON public.content_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

DROP TRIGGER IF EXISTS trg_card_pipeline_runs_set_updated_at ON public.card_pipeline_runs;
CREATE TRIGGER trg_card_pipeline_runs_set_updated_at
  BEFORE UPDATE ON public.card_pipeline_runs
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();

DROP TRIGGER IF EXISTS trg_card_generation_tasks_set_updated_at
  ON public.card_generation_tasks;
CREATE TRIGGER trg_card_generation_tasks_set_updated_at
  BEFORE UPDATE ON public.card_generation_tasks
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
