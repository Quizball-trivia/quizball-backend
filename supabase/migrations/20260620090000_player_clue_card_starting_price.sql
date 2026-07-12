-- =============================================================================
-- Migration: Player clue card Auction price fields
-- Description: Exposes true Auction value and decorrelated starting price from
--              player_clue_card_content_view for realtime Auction runtime.
-- =============================================================================

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
  ] AS starting_price_eur
FROM public.player_clue_cards pcc
JOIN public.football_players fp
  ON fp.id = pcc.football_player_id
LEFT JOIN public.player_clue_generation_candidates pcgc
  ON pcgc.football_player_id = pcc.football_player_id
LEFT JOIN public.auction_player_pricing app
  ON app.football_player_id = pcc.football_player_id;
