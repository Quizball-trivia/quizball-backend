-- Football Codenames seats eight (two teams of four); every other room game keeps its cap of six or fewer in code.
-- The seat range checks are added NOT VALID here, validated in 20261019120140 and swapped in 20261019120180.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_room_seats_slot_v2' AND conrelid = 'public.room_seats'::regclass) THEN
    ALTER TABLE public.room_seats ADD CONSTRAINT chk_room_seats_slot_v2 CHECK (slot BETWEEN 0 AND 7) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_room_seats_seat_v2' AND conrelid = 'public.room_seats'::regclass) THEN
    ALTER TABLE public.room_seats ADD CONSTRAINT chk_room_seats_seat_v2 CHECK (seat IS NULL OR seat BETWEEN 0 AND 7) NOT VALID;
  END IF;
END $$;
