-- =============================================================================
-- Migration: Auction player market value history
-- Description: Stores raw Transfermarkt valuation history separately from
--              football_players.current_value_eur and exposes current-value-only
--              Auction pricing/eligibility views.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.football_player_market_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  football_player_id uuid REFERENCES public.football_players(id) ON DELETE SET NULL,
  transfermarkt_id text NOT NULL,
  valuation_date date NOT NULL,
  value_eur bigint NOT NULL CHECK (value_eur > 0),
  club_name text,
  source text NOT NULL DEFAULT 'transfermarkt_dataset'
    CHECK (source IN ('transfermarkt_dataset')),
  source_payload jsonb NOT NULL
    CHECK (jsonb_typeof(source_payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_football_player_market_values_tm_date_source_unique
  ON public.football_player_market_values (transfermarkt_id, valuation_date, source);

CREATE INDEX IF NOT EXISTS idx_football_player_market_values_tm_date
  ON public.football_player_market_values (transfermarkt_id, valuation_date DESC);

CREATE INDEX IF NOT EXISTS idx_football_player_market_values_date
  ON public.football_player_market_values (valuation_date DESC);

CREATE INDEX IF NOT EXISTS idx_football_player_market_values_value
  ON public.football_player_market_values (value_eur DESC);

DROP TRIGGER IF EXISTS trg_football_player_market_values_set_updated_at
  ON public.football_player_market_values;
CREATE TRIGGER trg_football_player_market_values_set_updated_at
  BEFORE UPDATE ON public.football_player_market_values
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

CREATE OR REPLACE VIEW public.auction_player_pricing AS
SELECT
  fp.id AS football_player_id,
  fp.transfermarkt_id,
  fp.name,
  fp.position_group,
  fp.image_url,
  fp.current_value_eur,
  fp.current_value_eur AS auction_price_eur,
  CASE
    WHEN fp.current_value_eur IS NOT NULL THEN 'current_market_value'::text
    ELSE NULL::text
  END AS auction_price_source,
  CASE
    WHEN fp.current_value_eur IS NOT NULL THEN 'high'::text
    ELSE NULL::text
  END AS auction_price_confidence,
  (
    fp.current_value_eur IS NOT NULL
    AND fp.position_group IN ('GK', 'DEF', 'MID', 'FWD')
    AND fp.image_url IS NOT NULL
  ) AS normal_auction_eligible
FROM public.football_players fp;

CREATE OR REPLACE VIEW public.auction_player_eligibility_summary AS
SELECT
  COUNT(*)::bigint AS total_players,
  COUNT(*) FILTER (WHERE current_value_eur IS NOT NULL)::bigint AS current_value_count,
  COUNT(*) FILTER (WHERE current_value_eur IS NULL)::bigint AS missing_current_value_count,
  COUNT(*) FILTER (
    WHERE position_group IN ('GK', 'DEF', 'MID', 'FWD')
  )::bigint AS valid_position_group_count,
  COUNT(*) FILTER (WHERE image_url IS NOT NULL)::bigint AS image_url_count,
  COUNT(*) FILTER (WHERE normal_auction_eligible)::bigint AS normal_auction_eligible_count,
  COUNT(*) FILTER (
    WHERE current_value_eur IS NOT NULL
      AND NOT normal_auction_eligible
  )::bigint AS priced_but_not_normal_eligible_count
FROM public.auction_player_pricing;
