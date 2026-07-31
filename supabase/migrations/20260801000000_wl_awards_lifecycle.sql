-- PR4 award-lifecycle + QP-economy DDL (the shipped foundations migration is
-- immutable history — all changes land here as explicit ALTERs).

-- 1) Awards cascade with legitimate tournament deletion; direct deletion of
--    entitlements/audit stays rejected (the trigger allows a DELETE only
--    when the parent row is already gone, i.e. during the cascade).
ALTER TABLE public.wl_awards DROP CONSTRAINT IF EXISTS wl_awards_tournament_id_fkey;
ALTER TABLE public.wl_awards
  ADD CONSTRAINT wl_awards_tournament_id_fkey
  FOREIGN KEY (tournament_id) REFERENCES public.wl_tournaments(id) ON DELETE CASCADE;
ALTER TABLE public.wl_award_actions DROP CONSTRAINT IF EXISTS wl_award_actions_award_id_fkey;
ALTER TABLE public.wl_award_actions
  ADD CONSTRAINT wl_award_actions_award_id_fkey
  FOREIGN KEY (award_id) REFERENCES public.wl_awards(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.wl_awards_guard()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.wl_tournaments t WHERE t.id = OLD.tournament_id) THEN
      RAISE EXCEPTION 'wl_awards rows cannot be deleted directly (delete the tournament)';
    END IF;
    RETURN OLD; -- cascade from tournament deletion
  END IF;
  IF NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.final_rank IS DISTINCT FROM OLD.final_rank
     OR NEW.band IS DISTINCT FROM OLD.band
     OR NEW.prize_type IS DISTINCT FROM OLD.prize_type
     OR NEW.prize_value IS DISTINCT FROM OLD.prize_value
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'wl_awards entitlement fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.wl_award_actions_append_only()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.wl_awards a WHERE a.id = OLD.award_id) THEN
      RAISE EXCEPTION 'wl_award_actions rows cannot be deleted directly';
    END IF;
    RETURN OLD; -- cascade
  END IF;
  RAISE EXCEPTION 'wl_award_actions rows cannot be updated';
END;
$$ LANGUAGE plpgsql;

-- 2) QP wallet ordering: award and reset timestamps must reflect the moment
--    the row is WRITTEN (after any user-row lock wait), never transaction
--    start — otherwise an award blocked behind an entry commits with a
--    created_at earlier than the reset and vanishes from the balance.
ALTER TABLE public.wl_qp_awards ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE public.wl_qp_resets ALTER COLUMN reset_at SET DEFAULT clock_timestamp();

-- 3) Bootstrap grants are neither wins nor losses.
ALTER TABLE public.wl_qp_awards DROP CONSTRAINT IF EXISTS wl_qp_awards_result_check;
ALTER TABLE public.wl_qp_awards
  ADD CONSTRAINT wl_qp_awards_result_check CHECK (result IN ('win', 'loss', 'grant'));
