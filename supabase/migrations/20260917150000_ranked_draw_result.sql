-- Penalty shootout DRAW: a level shootout after the regulation kicks ends
-- with no winner (matches.winner_user_id NULL, state_payload
-- winnerDecisionMethod 'draw'). Ranked settlement records result 'draw' for
-- both participants (+10 RP, 475 coins), and Weekend League credits a draw QP
-- award. Widen the two result check constraints accordingly.

ALTER TABLE public.ranked_rp_changes DROP CONSTRAINT IF EXISTS ranked_rp_changes_result_check;
ALTER TABLE public.ranked_rp_changes
  ADD CONSTRAINT ranked_rp_changes_result_check CHECK (result IN ('win', 'loss', 'draw'));

ALTER TABLE public.wl_qp_awards DROP CONSTRAINT IF EXISTS wl_qp_awards_result_check;
ALTER TABLE public.wl_qp_awards
  ADD CONSTRAINT wl_qp_awards_result_check CHECK (result IN ('win', 'loss', 'grant', 'draw'));
