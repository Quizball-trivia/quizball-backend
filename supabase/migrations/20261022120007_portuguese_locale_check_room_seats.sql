-- Portuguese (pt) becomes a locale: room_seats's locale check, widened NOT VALID (validated later under a weaker lock).
-- One table per migration: each runs in its own transaction, so no table's lock waits on another's.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

ALTER TABLE public.room_seats
  DROP CONSTRAINT IF EXISTS chk_room_seats_locale,
  ADD CONSTRAINT chk_room_seats_locale
    CHECK (locale IN ('es', 'en', 'ka', 'tr', 'ru', 'pt')) NOT VALID;
