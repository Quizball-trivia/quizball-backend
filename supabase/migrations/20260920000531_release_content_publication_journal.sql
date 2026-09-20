-- Keep publication receipts in the existing private journal. Publication uses
-- its own batch id and records the original content-import batch separately.
ALTER TABLE public.reference_release_rows DROP CONSTRAINT reference_release_rows_table_name_check;
ALTER TABLE public.reference_release_rows ADD CONSTRAINT reference_release_rows_table_name_check
 CHECK (table_name IN ('football_players','fifa_cards','goal_choreographies','player_clue_cards',
                      'football_player_name_translations','player_season_snapshots',
                      'squad_spin_combos','football_grid_content_releases'));
ALTER TABLE public.reference_release_rows DROP CONSTRAINT reference_release_rows_operation_check;
ALTER TABLE public.reference_release_rows ADD CONSTRAINT reference_release_rows_operation_check
 CHECK (operation IN ('insert','fill-null-labels','publish'));
ALTER TABLE public.reference_release_rows ADD COLUMN content_batch_id text
 CHECK (content_batch_id IS NULL OR content_batch_id ~ '^[a-f0-9]{64}$');
