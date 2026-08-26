-- Historically-priced auction starting prices (FALLBACK path).
--
-- The primary starting price is set at round time by the content service:
-- the SCOUT season's real market value — the figure the card itself shows
-- (attachSeasonSnapshots in auction-content.service.ts). This view column is
-- only the guard for a malformed/missing snapshot value.
--
-- The old fallback was an md5 hash of the clue-card id mapped onto
-- {10,20,30,40,50}M — pure randomness; 66% of published lots priced ABOVE
-- the player's real value (which, combined with the now-removed forced
-- -opener rule, forced guaranteed-loss purchases). This replaces it with a
-- REAL Transfermarkt valuation from the player's own career — a hash-picked
-- point among the seasons where he was worth at most 90% of his current
-- (hidden) value. Last resort (career-bottom players with no sub-90%
-- history, 19/1401 on staging): half of current value, floored at €500k.
--
-- Staging-validated 2026-08-25: avg price/value 0.33, p50 0.27, p90 0.80,
-- 0 lots above value (vs 931/1401 under the hash-bucket scheme).
--
-- Only the starting_price_eur expression changes; every other column of the
-- view is restated verbatim (CREATE OR REPLACE VIEW requires the full body).

-- The lateral history pick needs this: football_player_market_values (519k
-- rows) has no index on football_player_id. Plain CREATE INDEX on purpose —
-- CONCURRENTLY cannot run inside the migration runner's transaction.
CREATE INDEX IF NOT EXISTS idx_football_player_market_values_player
  ON public.football_player_market_values (football_player_id)
  INCLUDE (value_eur, valuation_date);

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
  COALESCE(
    hist.value_eur,
    GREATEST(
      500000::bigint,
      (round(
        COALESCE(app.auction_price_eur, pcgc.auction_price_eur, fp.current_value_eur) * 0.5 / 1000000.0
      ) * 1000000)::bigint
    )
  ) AS starting_price_eur,
  fp.active_status
FROM public.player_clue_cards pcc
JOIN public.football_players fp
  ON fp.id = pcc.football_player_id
LEFT JOIN public.player_clue_generation_candidates pcgc
  ON pcgc.football_player_id = pcc.football_player_id
LEFT JOIN public.auction_player_pricing app
  ON app.football_player_id = pcc.football_player_id
LEFT JOIN LATERAL (
  SELECT h.value_eur
  FROM public.football_player_market_values h
  WHERE h.football_player_id = pcc.football_player_id
    AND h.value_eur > 0
    AND h.value_eur <= 0.9 * COALESCE(app.auction_price_eur, pcgc.auction_price_eur, fp.current_value_eur)
  ORDER BY md5(pcc.id::text || h.valuation_date::text)
  LIMIT 1
) hist ON true;
