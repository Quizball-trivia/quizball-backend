-- =============================================================================
-- Migration: Card pipeline worker heartbeats + prompt overrides
-- Source contract: quizball-auction-content/MIGRATION-REQUIREMENTS.sql
--
-- pipeline_workers  — one row per live runner thread, upserted on every stage
--                     transition and deleted on exit. The CMS reads it to show
--                     what each worker is generating right now; rows older than
--                     ~2 minutes are treated as stale by the API.
-- pipeline_prompts  — operator-editable overrides for the generator/verifier/
--                     judge rule blocks and the per-variant instructions. The
--                     runner falls back to its built-in defaults when a key is
--                     absent, empty or malformed.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.pipeline_workers (
  worker_id text PRIMARY KEY,
  hostname text NOT NULL,
  pipeline_run_id uuid REFERENCES public.card_pipeline_runs(id) ON DELETE SET NULL,
  task_id uuid REFERENCES public.card_generation_tasks(id) ON DELETE SET NULL,
  player_name text,
  variant_key text CHECK (variant_key IS NULL OR variant_key IN ('medium', 'hard')),
  stage text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_workers_updated
  ON public.pipeline_workers (updated_at DESC);

CREATE TABLE IF NOT EXISTS public.pipeline_prompts (
  -- Editable override rows use the bare key; the runner also publishes the
  -- assembled read-only text it will actually send under '<key>:effective'.
  key text PRIMARY KEY CHECK (
    key IN (
      'generator_rules', 'verifier_rules', 'judge_rules',
      'variant_medium', 'variant_hard',
      'generator_rules:effective', 'verifier_rules:effective',
      'judge_rules:effective', 'variant_medium:effective',
      'variant_hard:effective'
    )
  ),
  text text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

DROP TRIGGER IF EXISTS trg_pipeline_prompts_set_updated_at ON public.pipeline_prompts;
CREATE TRIGGER trg_pipeline_prompts_set_updated_at
  BEFORE UPDATE ON public.pipeline_prompts
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
