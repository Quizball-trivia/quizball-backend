SET LOCAL lock_timeout = '5s';

-- Validation scans do not take ACCESS EXCLUSIVE and run after the short column
-- expansion transaction has committed.
ALTER TABLE public.users
  VALIDATE CONSTRAINT users_tic_tac_toe_points_nonnegative_check;
ALTER TABLE public.users
  VALIDATE CONSTRAINT users_tic_tac_toe_points_timestamp_check;
ALTER TABLE public.football_grid_reward_eligibility
  VALIDATE CONSTRAINT football_grid_reward_eligibility_points_decision_check;
