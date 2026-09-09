-- Turkish catalog import: allow Turkish auction clue-card rows and Guess the
-- Goal match labels. Question/category/store copy lives in existing JSONB
-- columns and needs no schema change.

ALTER TABLE public.player_clue_cards
  DROP CONSTRAINT IF EXISTS player_clue_cards_locale_check;

ALTER TABLE public.player_clue_cards
  ADD CONSTRAINT player_clue_cards_locale_check
  CHECK (locale IN ('en', 'ka', 'es', 'tr'));

DO $$
BEGIN
  IF to_regclass('public.goal_choreographies') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.goal_choreographies ADD COLUMN IF NOT EXISTS match_label_tr TEXT';
  END IF;
END
$$;
