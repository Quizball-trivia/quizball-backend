-- Freecroco partner plays of Guess the Goal and FIFA Card Detective (contract v1.2 §7.3, §7.4). Each row belongs to
-- one partner_plays row and holds what the server needs to judge the play and settle it exactly once: the deadlines
-- the sweeper settles abandoned plays at, and (Card Detective) the dealt cards with their answers, which never leave
-- the server before the player has resolved a card. New tables only; nothing existing is touched.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- The goal itself is a guess_the_goal_sessions row of the partner player's users row (same snapshot and seen-goal
-- rules as quizball.io); this row adds the partner deadlines and the base points pinned at the start.
CREATE TABLE IF NOT EXISTS public.partner_ggt_plays (
  play_id uuid PRIMARY KEY REFERENCES public.partner_plays(id),
  session_id uuid NOT NULL UNIQUE REFERENCES public.guess_the_goal_sessions(id),
  user_id uuid NOT NULL REFERENCES public.users(id),
  base_points integer NOT NULL,
  -- No main-answer time limit (contract §7.4): a goal left unanswered this long is abandoned with 0.
  abandon_deadline timestamptz NOT NULL,
  -- Set when a right main answer opens the bonus question.
  bonus_deadline timestamptz,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_ggt_plays_base CHECK (base_points IN (40, 100))
);
CREATE INDEX IF NOT EXISTS idx_partner_ggt_plays_open
  ON public.partner_ggt_plays (abandon_deadline)
  WHERE settled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_partner_ggt_plays_user_open
  ON public.partner_ggt_plays (user_id)
  WHERE settled_at IS NULL;

-- cards: [{ ref, cardId, card: {...answer data...}, coins, open[], wrongGuesses, status, points }] in deal order.
CREATE TABLE IF NOT EXISTS public.partner_card_detective_plays (
  play_id uuid PRIMARY KEY REFERENCES public.partner_plays(id),
  player_id uuid NOT NULL REFERENCES public.partner_players(id),
  cards jsonb NOT NULL,
  current_index smallint NOT NULL DEFAULT 0,
  -- Bumped by every accepted action; a retried action carrying an old version is refused instead of charged twice.
  version integer NOT NULL DEFAULT 0,
  -- Moves forward with every action; a play left idle past it is settled with the points earned so far.
  idle_deadline timestamptz NOT NULL,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_partner_card_detective_plays_cards CHECK (jsonb_typeof(cards) = 'array' AND jsonb_array_length(cards) BETWEEN 1 AND 10),
  CONSTRAINT chk_partner_card_detective_plays_index CHECK (current_index BETWEEN 0 AND 10),
  CONSTRAINT chk_partner_card_detective_plays_version CHECK (version >= 0)
);
CREATE INDEX IF NOT EXISTS idx_partner_card_detective_plays_open
  ON public.partner_card_detective_plays (idle_deadline)
  WHERE settled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_partner_card_detective_plays_player
  ON public.partner_card_detective_plays (player_id, created_at DESC);

-- Server-only, like every partner table: answers live here.
ALTER TABLE public.partner_ggt_plays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_card_detective_plays ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_ggt_plays, public.partner_card_detective_plays FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.partner_ggt_plays, public.partner_card_detective_plays TO service_role;
