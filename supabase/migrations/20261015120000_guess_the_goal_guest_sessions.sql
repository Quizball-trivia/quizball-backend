-- Guess the Goal for guests: a session belongs to a member (user_id) or to a guest session (guest_id), never both,
-- like buscaminas_runs. Guest sessions earn nothing (the CHECK below holds that even against a code bug) and never
-- touch guess_the_goal_solves, whose primary key is (user_id, goal_id): a guest's solved goals are its correct
-- sessions. Guest sessions go with their guest session when the sweeper retires it.
-- The table holds a few thousand rows on prod, so the CHECK validation and the index builds below are brief.
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.guess_the_goal_sessions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.guess_the_goal_sessions
  ADD COLUMN IF NOT EXISTS guest_id uuid REFERENCES public.guest_sessions(id) ON DELETE CASCADE;

ALTER TABLE public.guess_the_goal_sessions DROP CONSTRAINT IF EXISTS chk_ggt_sessions_owner;
ALTER TABLE public.guess_the_goal_sessions
  ADD CONSTRAINT chk_ggt_sessions_owner CHECK ((user_id IS NULL) <> (guest_id IS NULL));

ALTER TABLE public.guess_the_goal_sessions DROP CONSTRAINT IF EXISTS chk_ggt_sessions_guest_unrewarded;
ALTER TABLE public.guess_the_goal_sessions
  ADD CONSTRAINT chk_ggt_sessions_guest_unrewarded CHECK (
    guest_id IS NULL OR (
      NOT first_solve AND coins_awarded = 0 AND xp_awarded = 0
      AND bonus_coins_awarded = 0 AND bonus_xp_awarded = 0
    )
  );

-- The member indexes bind member rows only (NULL user_ids are distinct); guests get the same rules.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ggt_sessions_guest_active
  ON public.guess_the_goal_sessions (guest_id)
  WHERE guest_id IS NOT NULL AND state IN ('active', 'guessed');

CREATE UNIQUE INDEX IF NOT EXISTS uq_ggt_sessions_guest_nonce
  ON public.guess_the_goal_sessions (guest_id, client_nonce)
  WHERE guest_id IS NOT NULL AND client_nonce IS NOT NULL;

-- Daily count, seen/solved goals, and the guest_sessions ON DELETE CASCADE lookup.
CREATE INDEX IF NOT EXISTS idx_ggt_sessions_guest_goal
  ON public.guess_the_goal_sessions (guest_id, goal_id)
  WHERE guest_id IS NOT NULL;
