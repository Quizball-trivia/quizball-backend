-- Russian (ru) becomes a public locale: duel_participants's locale check, widened NOT VALID (validated later under a weaker lock).
-- One table per migration: each runs in its own transaction, so no table's lock waits on another's.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.duel_participants
  DROP CONSTRAINT IF EXISTS chk_duel_participants_locale,
  ADD CONSTRAINT chk_duel_participants_locale
    CHECK (locale IN ('es', 'en', 'ka', 'tr', 'ru')) NOT VALID;
