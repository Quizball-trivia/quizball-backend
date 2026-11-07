-- Separate transaction from the CHECK replacements: validation allows gameplay writes.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.football_grid_command_inbox VALIDATE CONSTRAINT football_grid_command_inbox_locale_check;
ALTER TABLE public.football_grid_attempts VALIDATE CONSTRAINT football_grid_attempts_locale_check;
ALTER TABLE public.football_grid_claims VALIDATE CONSTRAINT football_grid_claims_submitted_locale_check;
ALTER TABLE public.football_grid_player_aliases VALIDATE CONSTRAINT football_grid_player_aliases_locale_check;
ALTER TABLE public.player_clue_cards VALIDATE CONSTRAINT player_clue_cards_locale_check;
ALTER TABLE public.season3_survey_responses VALIDATE CONSTRAINT season3_survey_responses_locale_check;
ALTER TABLE public.duel_participants VALIDATE CONSTRAINT chk_duel_participants_locale;
ALTER TABLE public.room_seats VALIDATE CONSTRAINT chk_room_seats_locale;
ALTER TABLE public.mobile_push_devices VALIDATE CONSTRAINT mobile_push_devices_locale_check;
ALTER TABLE public.game_feedback VALIDATE CONSTRAINT chk_game_feedback_locale;
