-- After-game feedback: a star rating, "would you play it online against a random opponent", an optional comment.
-- One answer per player per game (sending again replaces it); members by account, guests by guest session.
CREATE TABLE IF NOT EXISTS public.game_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game text NOT NULL,
  mode text NOT NULL,
  user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  guest_id uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE,
  rating smallint NOT NULL,
  wants_online boolean,
  comment text,
  locale text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_game_feedback_game CHECK (game IN ('tenable')),
  CONSTRAINT chk_game_feedback_mode CHECK (mode IN ('solo', 'room')),
  CONSTRAINT chk_game_feedback_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL)),
  CONSTRAINT chk_game_feedback_rating CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT chk_game_feedback_comment CHECK (comment IS NULL OR char_length(comment) BETWEEN 1 AND 500),
  CONSTRAINT chk_game_feedback_locale CHECK (locale IN ('en', 'ka', 'es', 'tr', 'ru'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_game_feedback_user ON public.game_feedback (game, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_game_feedback_guest ON public.game_feedback (game, guest_id) WHERE guest_id IS NOT NULL;
ALTER TABLE public.game_feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.game_feedback FROM PUBLIC, anon, authenticated;
