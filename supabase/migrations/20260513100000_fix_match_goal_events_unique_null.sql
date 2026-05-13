-- Make the match_goal_events unique index NULL-safe.
--
-- The original index (migration 20260509120000) used q_index directly in the
-- uniqueness key, which means two rows with q_index = NULL would both pass
-- uniqueness because PostgreSQL treats NULLs as distinct by default. Goal
-- events with NULL q_index (penalty/shot phases) could therefore be inserted
-- twice, defeating insertGoalEventIfMissing's dedupe guarantee.
--
-- Postgres 15+ supports NULLS NOT DISTINCT on unique indexes which treats NULL
-- values as equal for uniqueness purposes — exactly what we want here.

DROP INDEX IF EXISTS public.match_goal_events_unique_goal;

CREATE UNIQUE INDEX match_goal_events_unique_goal
  ON public.match_goal_events (match_id, user_id, phase_kind, q_index, is_penalty)
  NULLS NOT DISTINCT;
