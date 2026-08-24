-- =============================================================================
-- Migration: Fix Auction pricing eligibility summary
-- Description: Makes normal auction eligibility null-safe and exposes common
--              player fields directly from auction_player_pricing.
-- =============================================================================

DROP VIEW IF EXISTS public.auction_player_eligibility_summary;
DROP VIEW IF EXISTS public.auction_player_pricing;

CREATE VIEW public.auction_player_pricing AS
SELECT
  fp.id AS football_player_id,
  fp.transfermarkt_id,
  fp.name,
  fp.current_club,
  fp.position_group,
  fp.image_url,
  fp.current_value_eur,
  fp.peak_value_eur,
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
    AND COALESCE(fp.position_group IN ('GK', 'DEF', 'MID', 'FWD'), false)
    AND fp.image_url IS NOT NULL
  ) AS normal_auction_eligible
FROM public.football_players fp;

CREATE VIEW public.auction_player_eligibility_summary AS
SELECT
  COUNT(*)::bigint AS total_players,
  COUNT(*) FILTER (WHERE current_value_eur IS NOT NULL)::bigint AS current_value_count,
  COUNT(*) FILTER (WHERE current_value_eur IS NULL)::bigint AS missing_current_value_count,
  COUNT(*) FILTER (
    WHERE position_group IN ('GK', 'DEF', 'MID', 'FWD')
  )::bigint AS valid_position_group_count,
  COUNT(*) FILTER (WHERE image_url IS NOT NULL)::bigint AS image_url_count,
  COUNT(*) FILTER (
    WHERE normal_auction_eligible IS TRUE
  )::bigint AS normal_auction_eligible_count,
  COUNT(*) FILTER (
    WHERE auction_price_eur IS NOT NULL
      AND normal_auction_eligible IS NOT TRUE
  )::bigint AS priced_but_not_normal_eligible_count
FROM public.auction_player_pricing;
