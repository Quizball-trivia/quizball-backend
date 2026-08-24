-- =============================================================================
-- Migration: Auction content pipeline schema
-- Description: Stores imported football player data, LLM generation metadata,
--              and editor-reviewed Auction draft cards.
-- =============================================================================

-- =============================================================================
-- Import Runs
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  job_name text NOT NULL,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'success', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  rows_read integer NOT NULL DEFAULT 0 CHECK (rows_read >= 0),
  rows_inserted integer NOT NULL DEFAULT 0 CHECK (rows_inserted >= 0),
  rows_updated integer NOT NULL DEFAULT 0 CHECK (rows_updated >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_runs_finished_after_started
    CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_import_runs_source_started
  ON public.import_runs (source, started_at DESC);

DROP TRIGGER IF EXISTS trg_import_runs_set_updated_at ON public.import_runs;
CREATE TRIGGER trg_import_runs_set_updated_at
  BEFORE UPDATE ON public.import_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- =============================================================================
-- Football Players
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.football_players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfermarkt_id text,
  wikidata_id text,
  name text NOT NULL,
  display_name jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(display_name) = 'object'),
  nationality text,
  nationality_code text,
  position_group text
    CHECK (position_group IN ('GK', 'DEF', 'MID', 'FWD')),
  current_club text,
  date_of_birth date,
  active_status text NOT NULL DEFAULT 'unknown'
    CHECK (active_status IN ('active', 'retired', 'legend', 'unknown')),
  image_url text,
  current_value_eur bigint CHECK (current_value_eur IS NULL OR current_value_eur >= 0),
  peak_value_eur bigint CHECK (peak_value_eur IS NULL OR peak_value_eur >= 0),
  fame_score numeric(8, 3) CHECK (fame_score IS NULL OR fame_score >= 0),
  fame_bucket text
    CHECK (fame_bucket IN ('superstar', 'known', 'niche', 'obscure', 'legend')),
  data_quality_status text NOT NULL DEFAULT 'pending'
    CHECK (data_quality_status IN ('pending', 'usable', 'needs_review', 'rejected')),
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(source_payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_football_players_transfermarkt_id_unique
  ON public.football_players (transfermarkt_id)
  WHERE transfermarkt_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_football_players_wikidata_id_unique
  ON public.football_players (wikidata_id)
  WHERE wikidata_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_football_players_fame_bucket
  ON public.football_players (fame_bucket);

CREATE INDEX IF NOT EXISTS idx_football_players_position_group
  ON public.football_players (position_group);

DROP TRIGGER IF EXISTS trg_football_players_set_updated_at ON public.football_players;
CREATE TRIGGER trg_football_players_set_updated_at
  BEFORE UPDATE ON public.football_players
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- =============================================================================
-- Player Market Values
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.player_market_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.football_players(id) ON DELETE CASCADE,
  value_eur bigint NOT NULL CHECK (value_eur >= 0),
  valuation_date date NOT NULL,
  value_type text NOT NULL
    CHECK (value_type IN ('current', 'historical', 'peak', 'synthetic')),
  source text NOT NULL
    CHECK (source IN ('transfermarkt_dataset', 'wikidata', 'manual', 'synthetic')),
  import_run_id uuid REFERENCES public.import_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_player_market_values_player_date
  ON public.player_market_values (player_id, valuation_date DESC);

DROP TRIGGER IF EXISTS trg_player_market_values_set_updated_at ON public.player_market_values;
CREATE TRIGGER trg_player_market_values_set_updated_at
  BEFORE UPDATE ON public.player_market_values
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- =============================================================================
-- Player Facts
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.player_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.football_players(id) ON DELETE CASCADE,
  fact_type text NOT NULL,
  fact_text_en text NOT NULL,
  fact_text_ka text,
  source_name text,
  source_url text,
  evidence_quote text,
  confidence numeric(5, 4)
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  status text NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'verified', 'rejected', 'needs_review')),
  discovered_by text NOT NULL
    CHECK (discovered_by IN ('transfermarkt_dataset', 'wikidata', 'wikipedia', 'llm_research', 'manual', 'derived')),
  verified_by_model text,
  verifier_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_player_facts_player_status
  ON public.player_facts (player_id, status);

DROP TRIGGER IF EXISTS trg_player_facts_set_updated_at ON public.player_facts;
CREATE TRIGGER trg_player_facts_set_updated_at
  BEFORE UPDATE ON public.player_facts
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- =============================================================================
-- LLM Generation Runs
-- Created before auction_cards so cards can point at their generator run. The
-- nullable auction_card_id foreign key is attached after auction_cards exists.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.llm_generation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL,
  model_name text NOT NULL,
  model_role text NOT NULL
    CHECK (model_role IN ('researcher', 'generator', 'verifier', 'translator')),
  prompt_version text NOT NULL,
  player_id uuid REFERENCES public.football_players(id) ON DELETE SET NULL,
  auction_card_id uuid,
  input_json jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(input_json) = 'object'),
  output_json jsonb
    CHECK (output_json IS NULL OR jsonb_typeof(output_json) = 'object'),
  raw_output text,
  status text NOT NULL
    CHECK (status IN ('success', 'failed', 'invalid_json', 'rejected')),
  error_message text,
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  token_usage jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(token_usage) = 'object'),
  cost_estimate numeric(12, 6)
    CHECK (cost_estimate IS NULL OR cost_estimate >= 0),
  editor_rating smallint
    CHECK (editor_rating IS NULL OR editor_rating BETWEEN 1 AND 5),
  editor_selected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llm_generation_runs_player_created
  ON public.llm_generation_runs (player_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_llm_generation_runs_set_updated_at ON public.llm_generation_runs;
CREATE TRIGGER trg_llm_generation_runs_set_updated_at
  BEFORE UPDATE ON public.llm_generation_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- =============================================================================
-- Auction Cards
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.auction_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id uuid NOT NULL REFERENCES public.football_players(id) ON DELETE RESTRICT,
  position_group text NOT NULL
    CHECK (position_group IN ('GK', 'DEF', 'MID', 'FWD')),
  true_value_eur bigint NOT NULL CHECK (true_value_eur > 0),
  starting_price_eur bigint NOT NULL CHECK (starting_price_eur >= 20000000),
  value_type text NOT NULL
    CHECK (value_type IN ('current', 'peak', 'synthetic')),
  card_type text NOT NULL DEFAULT 'normal'
    CHECK (card_type IN ('normal', 'safe_star', 'bargain', 'trap', 'obscure_gem', 'lookalike_story', 'legend')),
  difficulty text NOT NULL
    CHECK (difficulty IN ('easy', 'medium', 'hard', 'expert')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'needs_review', 'published', 'archived', 'rejected')),
  generator_model text,
  verifier_model text,
  prompt_version text,
  generation_run_id uuid REFERENCES public.llm_generation_runs(id) ON DELETE SET NULL,
  verification_status text NOT NULL DEFAULT 'needs_review'
    CHECK (verification_status IN ('passed', 'failed', 'needs_review')),
  verification_notes text,
  editor_notes text,
  published_at timestamptz,
  published_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auction_cards_status_created
  ON public.auction_cards (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_auction_cards_player
  ON public.auction_cards (player_id);

CREATE INDEX IF NOT EXISTS idx_auction_cards_position_status
  ON public.auction_cards (position_group, status);

CREATE INDEX IF NOT EXISTS idx_auction_cards_card_type_difficulty
  ON public.auction_cards (card_type, difficulty);

DROP TRIGGER IF EXISTS trg_auction_cards_set_updated_at ON public.auction_cards;
CREATE TRIGGER trg_auction_cards_set_updated_at
  BEFORE UPDATE ON public.auction_cards
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

ALTER TABLE public.llm_generation_runs
  DROP CONSTRAINT IF EXISTS llm_generation_runs_auction_card_id_fkey;

ALTER TABLE public.llm_generation_runs
  ADD CONSTRAINT llm_generation_runs_auction_card_id_fkey
  FOREIGN KEY (auction_card_id)
  REFERENCES public.auction_cards(id)
  ON DELETE SET NULL;

-- =============================================================================
-- Auction Card Clues
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.auction_card_clues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_card_id uuid NOT NULL REFERENCES public.auction_cards(id) ON DELETE CASCADE,
  clue_order smallint NOT NULL CHECK (clue_order BETWEEN 1 AND 3),
  clue_en text NOT NULL,
  clue_ka text NOT NULL,
  clue_kind text NOT NULL,
  -- Stores supporting player_facts.id values for this clue.
  -- PostgreSQL cannot enforce FK integrity inside uuid[] arrays, so
  -- application/pipeline validators must verify each id exists and belongs to
  -- the same player as the auction card. If stricter relational integrity is
  -- needed later, replace this with a normalized auction_card_clue_facts table.
  supported_fact_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auction_card_clues_card_order
  ON public.auction_card_clues (auction_card_id, clue_order);

DROP TRIGGER IF EXISTS trg_auction_card_clues_set_updated_at ON public.auction_card_clues;
CREATE TRIGGER trg_auction_card_clues_set_updated_at
  BEFORE UPDATE ON public.auction_card_clues
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();
