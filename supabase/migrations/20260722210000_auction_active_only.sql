-- =============================================================================
-- Migration: Active players only in the Auction content pool
-- Description: Retires published clue cards for inactive players and ensures
--              all Auction eligibility paths require an active player.
-- =============================================================================

UPDATE public.player_clue_cards
SET
  status = 'rejected',
  rejection_reason = 'legends retired from auction pool 2026-07-22'
WHERE status = 'published'
  AND football_player_id IN (
    SELECT id
    FROM public.football_players
    WHERE active_status <> 'active'
  );

-- Column list must match 20260619113000_fix_auction_pricing_summary.sql (the
-- latest definition, incl. current_club/peak_value_eur) — CREATE OR REPLACE
-- cannot drop view columns.
CREATE OR REPLACE VIEW public.auction_player_pricing AS
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
    AND fp.active_status = 'active'
  ) AS normal_auction_eligible
FROM public.football_players fp;

CREATE OR REPLACE VIEW public.player_clue_generation_candidates AS
SELECT
  app.football_player_id,
  CASE
    WHEN app.transfermarkt_id ~ '^[0-9]+$' THEN app.transfermarkt_id::bigint
    ELSE NULL::bigint
  END AS transfermarkt_id,
  app.name,
  app.current_club,
  app.position_group,
  CASE app.position_group
    WHEN 'GK' THEN 'Goalkeeper'
    WHEN 'DEF' THEN 'Defender'
    WHEN 'MID' THEN 'Midfielder'
    WHEN 'FWD' THEN 'Forward'
    ELSE NULL::text
  END AS position_label_en,
  CASE app.position_group
    WHEN 'GK' THEN 'მეკარე'
    WHEN 'DEF' THEN 'მცველი'
    WHEN 'MID' THEN 'ნახევარმცველი'
    WHEN 'FWD' THEN 'ფორვარდი'
    ELSE NULL::text
  END AS position_label_ka,
  app.image_url,
  app.current_value_eur,
  app.peak_value_eur,
  app.auction_price_eur,
  app.auction_price_source,
  app.auction_price_confidence,
  fp.nationality,
  fp.date_of_birth,
  true AS eligible_for_clue_generation,
  CASE
    WHEN app.auction_price_eur >= 150000000 THEN 'GOAT'
    WHEN app.auction_price_eur >= 100000000 THEN 'S_TIER'
    WHEN app.auction_price_eur >= 50000000 THEN 'A_TIER'
    WHEN app.auction_price_eur >= 20000000 THEN 'B_TIER'
    WHEN app.auction_price_eur >= 5000000 THEN 'C_TIER'
    ELSE 'D_TIER'
  END AS value_bucket,
  CASE
    WHEN app.auction_price_eur >= 100000000 THEN 'easy'
    WHEN app.auction_price_eur >= 20000000 THEN 'medium'
    ELSE 'hard'
  END AS difficulty
FROM public.auction_player_pricing app
JOIN public.football_players fp
  ON fp.id = app.football_player_id
WHERE app.normal_auction_eligible IS TRUE
  AND app.auction_price_eur IS NOT NULL
  AND app.image_url IS NOT NULL
  AND app.position_group IN ('GK', 'DEF', 'MID', 'FWD')
  AND fp.active_status = 'active';

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
    (((('x' || substr(md5(pcc.id::text), 1, 8))::bit(32)::bigint % 5) + 5) % 5) + 1
  ] AS starting_price_eur,
  fp.active_status
FROM public.player_clue_cards pcc
JOIN public.football_players fp
  ON fp.id = pcc.football_player_id
LEFT JOIN public.player_clue_generation_candidates pcgc
  ON pcgc.football_player_id = pcc.football_player_id
LEFT JOIN public.auction_player_pricing app
  ON app.football_player_id = pcc.football_player_id;

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
