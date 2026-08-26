-- Band-prefer the fallback starting-price season pick.
--
-- starting_price_eur stops being a rare malformed-snapshot guard: the content
-- service now rejects scout-season prices above 90% of the hidden current
-- value (guaranteed-loss openings — see attachSeasonSnapshots), so every such
-- lot (~42% of draws under the veteran-heavy fame mix) opens at this view's
-- price instead. A uniform hash pick over ALL sub-90% seasons could land on a
-- junior-year valuation (Müller at €100k) — a legend opening at pennies reads
-- as a bug and turns the round into a long bid ladder. Prefer seasons worth
-- at least 25% of current value; only players with no such season fall back
-- to the unbanded pick, and the €500k-floored half-value last resort stays.
--
-- Only the lateral pick's ORDER BY changes; every other column of the view
-- is restated verbatim (CREATE OR REPLACE VIEW requires the full body).

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
    -- Last resort: half of current value rounded to €1M, floored at €500k —
    -- but the floor may never itself breach the 90% cap, so below ~€555k of
    -- current value the cap wins and the effective price is 0.9×value (the
    -- floor produced the only above-value openings left in the pool, 2/1311
    -- on staging). Sub-€20M openings are expected and correct for declined
    -- veterans whose CURRENT value is tiny: MIN_PLAYER_COST-based reserve and
    -- elimination math stays conservative-but-safe, as it was under the old
    -- €10M hash buckets.
    LEAST(
      GREATEST(
        500000::bigint,
        (round(
          COALESCE(app.auction_price_eur, pcgc.auction_price_eur, fp.current_value_eur) * 0.5 / 1000000.0
        ) * 1000000)::bigint
      ),
      floor(COALESCE(app.auction_price_eur, pcgc.auction_price_eur, fp.current_value_eur) * 0.9)::bigint
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
  ORDER BY
      (h.value_eur < 0.25 * COALESCE(app.auction_price_eur, pcgc.auction_price_eur, fp.current_value_eur)),
      md5(pcc.id::text || h.valuation_date::text)
  LIMIT 1
) hist ON true;
