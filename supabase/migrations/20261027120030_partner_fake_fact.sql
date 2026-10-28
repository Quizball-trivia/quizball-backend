-- Freecroco Fake Fact (contract §7.4 replacement for Guess the Goal): card 1 right = 100, a right bonus card +40.
-- Each row belongs to one partner_plays row and holds the two dealt cards with their answers (never sent before a
-- card is settled), the step the play is on and the deadline the sweeper settles an abandoned play at.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS public.partner_fake_fact_plays (
  play_id uuid PRIMARY KEY REFERENCES public.partner_plays(id),
  player_id uuid NOT NULL REFERENCES public.partner_players(id),
  -- [main, bonus] room_pool dato_falso cards as dealt (dfCardSchema).
  cards jsonb NOT NULL,
  -- room_pool item ids of `cards`.
  card_ids text[] NOT NULL,
  -- The ids of the cards actually opened (card 1 at the start, the bonus once opened): a player is dealt cards they
  -- have not been shown first.
  shown_ids text[] NOT NULL DEFAULT '{}',
  -- card1 → (right) between → card2 → done; a wrong or timed-out card 1 goes straight to done.
  step text NOT NULL DEFAULT 'card1',
  -- One entry per settled card: { pick: 0-4 | null (time ran out), right, points }.
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The open card's answer deadline, or (between) how long the bonus may wait to be opened.
  deadline timestamptz NOT NULL,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_fake_fact_plays_cards CHECK (jsonb_typeof(cards) = 'array' AND jsonb_array_length(cards) = 2),
  CONSTRAINT chk_partner_fake_fact_plays_card_ids CHECK (cardinality(card_ids) = 2),
  CONSTRAINT chk_partner_fake_fact_plays_step CHECK (step IN ('card1', 'between', 'card2', 'done')),
  CONSTRAINT chk_partner_fake_fact_plays_results CHECK (jsonb_typeof(results) = 'array' AND jsonb_array_length(results) <= 2)
);
CREATE INDEX IF NOT EXISTS idx_partner_fake_fact_plays_open
  ON public.partner_fake_fact_plays (deadline)
  WHERE settled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_partner_fake_fact_plays_player
  ON public.partner_fake_fact_plays (player_id, created_at DESC);

ALTER TABLE public.partner_fake_fact_plays ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_fake_fact_plays FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.partner_fake_fact_plays TO service_role;

-- Fake Fact is added switched off, last in the list: Freecroco staff switch it on (and Guess the Goal off) in the CMS
-- once the web screen is live and Freecroco accepts the new gameId. Nothing else in the list changes.
DO $$
DECLARE
  env record;
  last_order integer;
BEGIN
  FOR env IN SELECT partner_slug, environment FROM public.partner_config_versions WHERE partner_slug = 'freecroco' LOOP
    -- The version row first, as a CMS save takes it (partner-admin.service putGamesConfig): no lock-order deadlock.
    PERFORM 1 FROM public.partner_config_versions
      WHERE partner_slug = env.partner_slug AND environment = env.environment FOR UPDATE;
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.partner_games
                          WHERE partner_slug = env.partner_slug AND environment = env.environment AND game_id = 'fake-fact');
    SELECT COALESCE(max(sort_order), 0) INTO last_order FROM public.partner_games
      WHERE partner_slug = env.partner_slug AND environment = env.environment;
    INSERT INTO public.partner_games (partner_slug, environment, game_id, enabled, sort_order, default_limit, ready)
    VALUES (env.partner_slug, env.environment, 'fake-fact', false, last_order + 1, 1, true);
    -- A CMS tab holding the old list must reload before it can save over this one.
    UPDATE public.partner_config_versions SET games_version = games_version + 1
      WHERE partner_slug = env.partner_slug AND environment = env.environment;
  END LOOP;
END $$;
