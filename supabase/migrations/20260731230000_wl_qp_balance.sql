-- QP economy v2 (owner decision 2026-07-31): QP is a RUNNING BALANCE spent
-- on entry, not a weekly counter.
--   balance(user) = SUM(wl_qp_awards.points WHERE created_at > latest reset)
--   Entering a tournament inserts the reset row in the SAME claiming
--   transaction — "buy the ticket, reset to zero, grind again".
-- The award ledger is unchanged (weekly keys stay for analytics/audit); the
-- wl_qp weekly read-model remains for history but no longer gates entry.
--
-- Season-2 bootstrap: before the first event, every player receives one
-- ledger row under the reserved bootstrap match id with points derived from
-- their Season 2 record (25*wins + 10*losses). The PK (match_id, user_id)
-- makes the backfill idempotent.

CREATE TABLE IF NOT EXISTS public.wl_qp_resets (
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  tournament_id uuid NOT NULL REFERENCES public.wl_tournaments(id),
  reset_at timestamptz NOT NULL DEFAULT NOW(),
  balance_spent integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, tournament_id)
);

CREATE INDEX IF NOT EXISTS idx_wl_qp_resets_user_time
  ON public.wl_qp_resets (user_id, reset_at DESC);

-- Balance reads scan awards newer than the latest reset.
CREATE INDEX IF NOT EXISTS idx_wl_qp_awards_user_time
  ON public.wl_qp_awards (user_id, created_at);

ALTER TABLE public.wl_qp_resets ENABLE ROW LEVEL SECURITY;
