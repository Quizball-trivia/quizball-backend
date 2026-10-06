-- Freecroco dailies (Countdown, True/False, Pick Em, Career Path, Higher/Lower): a partner-only content pool and
-- one server-side state row per play. The browser only ever sees the current item; the selected set (with answers)
-- lives here. Additive, re-runnable.

-- Which bank questions a partner's dailies may draw from. `source` tells a copy of the public bank apart from
-- content written for the partner, so the copy can be retired once dedicated content exists.
CREATE TABLE IF NOT EXISTS public.partner_content_pool (
  partner_slug text NOT NULL,
  game_id text NOT NULL,
  question_id uuid NOT NULL REFERENCES public.questions(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'bank_copy',
  active boolean NOT NULL DEFAULT true,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner_slug, game_id, question_id),
  CONSTRAINT chk_partner_content_pool_game
    CHECK (game_id IN ('countdown', 'true-false', 'pick-em', 'career-path', 'higher-lower')),
  CONSTRAINT chk_partner_content_pool_source CHECK (source IN ('bank_copy', 'dedicated'))
);

CREATE TABLE IF NOT EXISTS public.partner_daily_plays (
  play_id uuid PRIMARY KEY REFERENCES public.partner_plays(id),
  game_id text NOT NULL,
  player_id uuid NOT NULL REFERENCES public.partner_players(id),
  question_ids uuid[] NOT NULL,
  -- Server-only snapshot of the selected content, answers included.
  items jsonb NOT NULL,
  item_states jsonb NOT NULL,
  current_index integer NOT NULL DEFAULT 0,
  item_deadline timestamptz NOT NULL,
  -- When the current item was resolved (answered, timed out or skipped); null while it is open.
  item_done_at timestamptz,
  score integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'playing',
  end_cause text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CONSTRAINT chk_partner_daily_plays_game
    CHECK (game_id IN ('countdown', 'true-false', 'pick-em', 'career-path', 'higher-lower')),
  CONSTRAINT chk_partner_daily_plays_state CHECK (state IN ('playing', 'finished', 'cancelled')),
  CONSTRAINT chk_partner_daily_plays_cause
    CHECK (end_cause IS NULL OR end_cause IN ('completed', 'quit', 'abandoned', 'blocked')),
  CONSTRAINT chk_partner_daily_plays_ended CHECK ((state = 'playing') = (ended_at IS NULL)),
  CONSTRAINT chk_partner_daily_plays_score CHECK (score >= 0),
  CONSTRAINT chk_partner_daily_plays_index CHECK (current_index >= 0)
);

-- One open play per player and game: a second start resumes it instead of opening another.
CREATE UNIQUE INDEX IF NOT EXISTS uq_partner_daily_plays_open
  ON public.partner_daily_plays (player_id, game_id) WHERE state = 'playing';
CREATE INDEX IF NOT EXISTS idx_partner_daily_plays_sweep
  ON public.partner_daily_plays (item_deadline) WHERE state = 'playing';
CREATE INDEX IF NOT EXISTS idx_partner_daily_plays_player_recent
  ON public.partner_daily_plays (player_id, game_id, created_at DESC);

-- A block cancels the player's started plays (partner_plays); the daily play ends with it in the same transaction,
-- so it can never be resumed or scored after an unblock.
CREATE OR REPLACE FUNCTION public.partner_daily_plays_follow_cancel() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.partner_daily_plays
  SET state = 'cancelled', end_cause = 'blocked', ended_at = clock_timestamp(), updated_at = clock_timestamp()
  WHERE play_id = NEW.id AND state = 'playing';
  RETURN NULL;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.partner_daily_plays_follow_cancel() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_partner_plays_cancel_daily ON public.partner_plays;
CREATE TRIGGER trg_partner_plays_cancel_daily
  AFTER UPDATE OF state ON public.partner_plays
  FOR EACH ROW WHEN (NEW.state = 'cancelled' AND OLD.state IS DISTINCT FROM 'cancelled')
  EXECUTE FUNCTION public.partner_daily_plays_follow_cancel();

-- Server-only (RLS without policies, no client grants), like the rest of the partner tables.
ALTER TABLE public.partner_content_pool ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_daily_plays ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_content_pool, public.partner_daily_plays FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.partner_content_pool, public.partner_daily_plays TO service_role;
