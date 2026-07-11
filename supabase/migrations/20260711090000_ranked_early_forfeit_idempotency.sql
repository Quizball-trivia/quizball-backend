CREATE TABLE IF NOT EXISTS public.ranked_early_forfeit_events (
  match_id uuid NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ranked_early_forfeit_events_user_created
  ON public.ranked_early_forfeit_events (user_id, created_at DESC);
