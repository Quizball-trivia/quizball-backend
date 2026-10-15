-- Russian (ru) becomes a public locale: widen the locale checks without scanning live tables under an exclusive lock.
-- The following migration validates them under a weaker lock.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.football_grid_command_inbox
  DROP CONSTRAINT IF EXISTS football_grid_command_inbox_locale_check,
  ADD CONSTRAINT football_grid_command_inbox_locale_check
    CHECK (locale IN ('en', 'ka', 'es', 'tr', 'ru')) NOT VALID;

ALTER TABLE public.football_grid_attempts
  DROP CONSTRAINT IF EXISTS football_grid_attempts_locale_check,
  ADD CONSTRAINT football_grid_attempts_locale_check
    CHECK (locale IN ('en', 'ka', 'es', 'tr', 'ru')) NOT VALID;

ALTER TABLE public.football_grid_claims
  DROP CONSTRAINT IF EXISTS football_grid_claims_submitted_locale_check,
  ADD CONSTRAINT football_grid_claims_submitted_locale_check
    CHECK (submitted_locale IN ('en', 'ka', 'es', 'tr', 'ru')) NOT VALID;

ALTER TABLE public.football_grid_player_aliases
  DROP CONSTRAINT IF EXISTS football_grid_player_aliases_locale_check,
  ADD CONSTRAINT football_grid_player_aliases_locale_check
    CHECK (locale IN ('en', 'ka', 'es', 'tr', 'ru', 'translit')) NOT VALID;

ALTER TABLE public.football_player_name_translations
  DROP CONSTRAINT IF EXISTS football_player_name_translations_locale_check,
  ADD CONSTRAINT football_player_name_translations_locale_check
    CHECK (locale IN ('ka', 'ru')) NOT VALID;

ALTER TABLE public.player_clue_cards
  DROP CONSTRAINT IF EXISTS player_clue_cards_locale_check,
  ADD CONSTRAINT player_clue_cards_locale_check
    CHECK (locale IN ('en', 'ka', 'es', 'tr', 'ru')) NOT VALID;

ALTER TABLE public.season3_survey_responses
  DROP CONSTRAINT IF EXISTS season3_survey_responses_locale_check,
  ADD CONSTRAINT season3_survey_responses_locale_check
    CHECK (locale IN ('en', 'ka', 'es', 'tr', 'ru')) NOT VALID;

ALTER TABLE public.duel_participants
  DROP CONSTRAINT IF EXISTS chk_duel_participants_locale,
  ADD CONSTRAINT chk_duel_participants_locale
    CHECK (locale IN ('es', 'en', 'ka', 'tr', 'ru')) NOT VALID;

ALTER TABLE public.room_seats
  DROP CONSTRAINT IF EXISTS chk_room_seats_locale,
  ADD CONSTRAINT chk_room_seats_locale
    CHECK (locale IN ('es', 'en', 'ka', 'tr', 'ru')) NOT VALID;

ALTER TABLE public.mobile_push_devices
  DROP CONSTRAINT IF EXISTS mobile_push_devices_locale_check,
  ADD CONSTRAINT mobile_push_devices_locale_check
    CHECK (locale IN ('en', 'ka', 'es', 'tr', 'ru')) NOT VALID;
