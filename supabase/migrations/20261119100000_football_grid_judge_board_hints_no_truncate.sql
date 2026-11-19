-- The board-hint copy (20261118140050) was created after TRUNCATE was revoked on the other judge tables
-- (20261118140040), and the platform's default privileges grant it to service_role on new tables. TRUNCATE skips the
-- row triggers that keep a sealed version immutable: revoke it here too.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

REVOKE TRUNCATE ON public.football_grid_judge_board_hints FROM PUBLIC, anon, authenticated, service_role;
