-- =============================================================================
-- Migration: Player clue card content foundation
-- Description: Stores reviewable player clue cards and exposes generation/content
--              views for Auction, Who-Am-I, and value-guessing card pipelines.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.player_clue_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  football_player_id uuid NOT NULL REFERENCES public.football_players(id) ON DELETE CASCADE,
  transfermarkt_id bigint,
  locale text NOT NULL
    CHECK (locale IN ('en', 'ka')),
  clue_1 text NOT NULL CHECK (length(btrim(clue_1)) > 0),
  clue_2 text NOT NULL CHECK (length(btrim(clue_2)) > 0),
  clue_3 text NOT NULL CHECK (length(btrim(clue_3)) > 0),
  difficulty text NOT NULL
    CHECK (difficulty IN ('easy', 'medium', 'hard')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'needs_review', 'approved', 'published', 'rejected')),
  source text NOT NULL DEFAULT 'generated'
    CHECK (source IN ('generated', 'manual', 'cms', 'imported')),
  generation_provider text,
  generation_model text,
  prompt_version text NOT NULL DEFAULT 'v1',
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(evidence) = 'object'),
  source_payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(source_payload) = 'object'),
  review_notes text,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_clue_cards_player_locale_prompt_unique
  ON public.player_clue_cards (football_player_id, locale, prompt_version);

CREATE INDEX IF NOT EXISTS idx_player_clue_cards_football_player
  ON public.player_clue_cards (football_player_id);

CREATE INDEX IF NOT EXISTS idx_player_clue_cards_transfermarkt
  ON public.player_clue_cards (transfermarkt_id);

CREATE INDEX IF NOT EXISTS idx_player_clue_cards_locale_status
  ON public.player_clue_cards (locale, status);

CREATE INDEX IF NOT EXISTS idx_player_clue_cards_difficulty_status
  ON public.player_clue_cards (difficulty, status);

CREATE INDEX IF NOT EXISTS idx_player_clue_cards_created
  ON public.player_clue_cards (created_at DESC);

DROP TRIGGER IF EXISTS trg_player_clue_cards_set_updated_at ON public.player_clue_cards;
CREATE TRIGGER trg_player_clue_cards_set_updated_at
  BEFORE UPDATE ON public.player_clue_cards
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

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
  AND app.position_group IN ('GK', 'DEF', 'MID', 'FWD');

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
  pcc.updated_at
FROM public.player_clue_cards pcc
JOIN public.football_players fp
  ON fp.id = pcc.football_player_id
LEFT JOIN public.player_clue_generation_candidates pcgc
  ON pcgc.football_player_id = pcc.football_player_id;
