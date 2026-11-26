-- Players of partner products that run on their own databases (Table Derby),
-- counted into Quizball's user totals. Integers per Asia/Tbilisi day only: no
-- partner player row or id is ever stored here. Written by the backend's
-- partner-stats sync (src/modules/partner-stats), read by admin-stats.
CREATE TABLE IF NOT EXISTS public.partner_daily_stats (
  partner text NOT NULL CHECK (partner IN ('table-derby')),
  day date NOT NULL,
  total_users integer NOT NULL CHECK (total_users >= 0),
  new_users integer NOT NULL CHECK (new_users >= 0),
  active_users integer NOT NULL CHECK (active_users >= 0),
  active_7d integer NOT NULL CHECK (active_7d >= 0),
  active_30d integer NOT NULL CHECK (active_30d >= 0),
  matches integer NOT NULL CHECK (matches >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (partner, day)
);

-- Backend only.
ALTER TABLE public.partner_daily_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partner_daily_stats FROM anon, authenticated;
