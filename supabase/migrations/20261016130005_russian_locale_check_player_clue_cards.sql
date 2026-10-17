-- Russian (ru) becomes a public locale: player_clue_cards's locale check, widened NOT VALID (validated later under a weaker lock).
-- One table per migration: each runs in its own transaction, so no table's lock waits on another's.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.player_clue_cards
  DROP CONSTRAINT IF EXISTS player_clue_cards_locale_check,
  ADD CONSTRAINT player_clue_cards_locale_check
    CHECK (locale IN ('en', 'ka', 'es', 'tr', 'ru')) NOT VALID;
