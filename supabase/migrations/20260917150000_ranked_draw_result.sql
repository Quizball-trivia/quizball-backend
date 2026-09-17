-- Penalty shootout DRAW: a level shootout after the regulation kicks ends
-- with no winner (matches.winner_user_id NULL, state_payload
-- winnerDecisionMethod 'draw'). Ranked settlement records result 'draw' for
-- both participants (+10 RP, 475 coins), and Weekend League credits a draw QP
-- award. Widen the two result check constraints accordingly.
--
-- NOT VALID: adding a CHECK with a full-table scan takes ACCESS EXCLUSIVE for
-- the scan and blocks ranked settlement writes during deploy. NOT VALID makes
-- the swap instant (new rows are checked immediately); the existing rows are
-- validated by the follow-up migration 20260917150100, which runs outside the
-- DDL transaction under SHARE UPDATE EXCLUSIVE only.
--
-- Idempotent: DROP IF EXISTS + re-ADD is harmless on a database that already
-- carries the widened constraint (staging applied an earlier version of this
-- file; the migration runner tracks versions, not content, so it is skipped
-- there anyway).

ALTER TABLE public.ranked_rp_changes DROP CONSTRAINT IF EXISTS ranked_rp_changes_result_check;
ALTER TABLE public.ranked_rp_changes
  ADD CONSTRAINT ranked_rp_changes_result_check CHECK (result IN ('win', 'loss', 'draw')) NOT VALID;

ALTER TABLE public.wl_qp_awards DROP CONSTRAINT IF EXISTS wl_qp_awards_result_check;
ALTER TABLE public.wl_qp_awards
  ADD CONSTRAINT wl_qp_awards_result_check CHECK (result IN ('win', 'loss', 'grant', 'draw')) NOT VALID;
