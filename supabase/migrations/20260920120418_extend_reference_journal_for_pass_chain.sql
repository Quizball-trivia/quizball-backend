-- migrate:no-transaction
-- Expand only the private import receipt allowlist. Keep the brief replacement
-- atomic, and validate existing receipts after releasing its exclusive lock.
DO $$ BEGIN
  ALTER TABLE public.reference_release_rows DROP CONSTRAINT reference_release_rows_table_name_check;
  ALTER TABLE public.reference_release_rows ADD CONSTRAINT reference_release_rows_table_name_check
    CHECK (table_name IN ('football_players','fifa_cards','goal_choreographies','player_clue_cards',
      'football_player_name_translations','player_season_snapshots','squad_spin_combos',
      'football_grid_content_releases','pass_chain_players','daily_challenge_configs')) NOT VALID;
END $$;
ALTER TABLE public.reference_release_rows VALIDATE CONSTRAINT reference_release_rows_table_name_check;
