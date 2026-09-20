-- Extend the existing private import journal; no catalogue row is changed.
ALTER TABLE public.reference_release_rows DROP CONSTRAINT reference_release_rows_table_name_check;
ALTER TABLE public.reference_release_rows ADD CONSTRAINT reference_release_rows_table_name_check
 CHECK (table_name IN ('football_players','fifa_cards','goal_choreographies','player_clue_cards',
                      'football_player_name_translations','player_season_snapshots'));
