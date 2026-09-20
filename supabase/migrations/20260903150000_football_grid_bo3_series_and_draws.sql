-- Football Tic Tac Toe: best-of-3 series and draw offers.
--
-- Series rows already exist (one per match chain, used by friend rematches).
-- They now carry the series format and running score so a random-opponent
-- match becomes game 1 of a best-of-3, with the server dealing the next board
-- itself. Draw offers are part of the durable match state so a reconnecting
-- client sees a pending offer, and a declined offer's lock survives restarts.

ALTER TABLE public.football_grid_series
  ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'single'
    CHECK (format IN ('single', 'bo3')),
  ADD COLUMN IF NOT EXISTS game_index integer NOT NULL DEFAULT 1 CHECK (game_index >= 1),
  ADD COLUMN IF NOT EXISTS seat1_wins integer NOT NULL DEFAULT 0 CHECK (seat1_wins >= 0),
  ADD COLUMN IF NOT EXISTS seat2_wins integer NOT NULL DEFAULT 0 CHECK (seat2_wins >= 0),
  ADD COLUMN IF NOT EXISTS draws integer NOT NULL DEFAULT 0 CHECK (draws >= 0),
  ADD COLUMN IF NOT EXISTS winner_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS theme text,
  ADD COLUMN IF NOT EXISTS closed_reason text,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  -- The finished game whose result was last folded into the score. Makes the
  -- series advance idempotent while the next game is still being created.
  ADD COLUMN IF NOT EXISTS last_advanced_match_id uuid REFERENCES public.matches(id) ON DELETE SET NULL;

ALTER TABLE public.football_grid_matches
  ADD COLUMN IF NOT EXISTS draw_offer jsonb;

ALTER TABLE public.football_grid_participants
  ADD COLUMN IF NOT EXISTS draw_offer_locked_until_turn integer NOT NULL DEFAULT 0
    CHECK (draw_offer_locked_until_turn >= 0);

-- Two new ways a game can end as a draw. Both count as a draw (0.5) for the
-- bot governor's outcome audit, like board_full.
ALTER TABLE public.football_grid_bot_governor_observations
  DROP CONSTRAINT IF EXISTS football_grid_bot_governor_observations_completion_reason_check;
ALTER TABLE public.football_grid_bot_governor_observations
  ADD CONSTRAINT football_grid_bot_governor_observations_completion_reason_check
    CHECK (completion_reason IN ('line', 'board_full', 'board_dead', 'draw_agreed', 'turn_limit'));
