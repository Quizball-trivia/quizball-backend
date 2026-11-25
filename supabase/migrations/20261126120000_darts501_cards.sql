-- Football Darts 501: how a category looks on the days calendar (board type, competition, short subject name per
-- language, crest or flag), kept apart from the category itself. A category's content is hashed for its content_version
-- and ledger revision, so a label change must never touch it; a card is display metadata only and never judges a dart.
-- Keyed by category id, so a pool category later scheduled as a day keeps its card. Private like every Darts table.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.darts501_cards (
  category_id text PRIMARY KEY,
  card jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_darts501_cards_category_id CHECK (char_length(category_id) BETWEEN 1 AND 80),
  CONSTRAINT chk_darts501_cards_card CHECK (jsonb_typeof(card) = 'object')
);

ALTER TABLE public.darts501_cards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.darts501_cards FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.darts501_cards TO service_role;

DROP TRIGGER IF EXISTS set_darts501_cards_updated_at ON public.darts501_cards;
CREATE TRIGGER set_darts501_cards_updated_at
  BEFORE UPDATE ON public.darts501_cards
  FOR EACH ROW EXECUTE FUNCTION public.trigger_set_updated_at();
