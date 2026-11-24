-- GRANT ALL includes TRUNCATE, which bypasses the row triggers that keep a sealed judge version immutable (a truncate
-- of football_grid_criterion_players would empty every version at once). Nobody truncates these tables.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '10s';

REVOKE TRUNCATE ON
  public.football_grid_judge_versions,
  public.football_grid_criterion_definitions,
  public.football_grid_criterion_bindings,
  public.football_grid_criterion_players,
  public.football_grid_judge_players,
  public.football_grid_judge_aliases,
  public.football_grid_judge_namesakes,
  public.football_grid_board_certifications,
  public.football_grid_judge_rollout,
  public.football_grid_shadow_verdicts
FROM PUBLIC, anon, authenticated, service_role;
