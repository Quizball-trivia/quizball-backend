SET LOCAL lock_timeout = '5s';

-- Preserve the original eligibility columns as the coin verdict for backward
-- compatibility, while recording the independently-derived TP verdict.
ALTER TABLE public.football_grid_reward_eligibility
  ADD COLUMN IF NOT EXISTS points_decision text,
  ADD COLUMN IF NOT EXISTS points_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.football_grid_reward_eligibility'::regclass
       AND conname = 'football_grid_reward_eligibility_points_decision_check'
  ) THEN
    ALTER TABLE public.football_grid_reward_eligibility
      ADD CONSTRAINT football_grid_reward_eligibility_points_decision_check
      CHECK (points_decision IS NULL OR points_decision IN ('eligible', 'ineligible', 'held'))
      NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.football_grid_point_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  reward_type text NOT NULL DEFAULT 'football_grid_match',
  amount integer NOT NULL CHECK (amount >= 0),
  status text NOT NULL CHECK (status IN ('committed', 'held', 'reversed')),
  eligibility_reason text NOT NULL,
  reversal_of uuid REFERENCES public.football_grid_point_events(id) ON DELETE RESTRICT,
  credited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, user_id, reward_type),
  FOREIGN KEY (match_id, user_id)
    REFERENCES public.football_grid_participants(match_id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS football_grid_point_events_user_idx
  ON public.football_grid_point_events (user_id, created_at DESC)
  WHERE status IN ('committed', 'held');

CREATE TABLE IF NOT EXISTS public.football_grid_point_event_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  point_event_id uuid NOT NULL REFERENCES public.football_grid_point_events(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('release', 'reverse')),
  amount integer NOT NULL CHECK (amount >= 0),
  reason text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.football_grid_point_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.football_grid_point_event_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE
  public.football_grid_point_events,
  public.football_grid_point_event_audit
FROM anon, authenticated;
