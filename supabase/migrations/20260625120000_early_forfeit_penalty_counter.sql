-- Early-forfeit abuse counter: tracks how many ranked matches a user has
-- forfeited before the 2-round no-contest threshold within a rolling 24h
-- window. At 4+ early-forfeits in the window the user is penalized (100 RP
-- deduction + no ticket refund) to prevent infinite reload-and-dodge spam.
--
-- Uses a tumbling-window approach: the window opens on the first early
-- forfeit and stays open for 24h. All early forfeits inside that window
-- increment the counter. After 24h elapse, the next early forfeit resets
-- the counter to 1 and opens a fresh window.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS early_forfeit_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS early_forfeit_window_started_at timestamp with time zone;

COMMENT ON COLUMN public.users.early_forfeit_count IS
  'Number of ranked early-forfeits (no-contest cancels) inside the current 24h window. Reset to 1 when the window expires.';
COMMENT ON COLUMN public.users.early_forfeit_window_started_at IS
  'When the current early-forfeit counting window opened. NULL means no early forfeits yet.';
