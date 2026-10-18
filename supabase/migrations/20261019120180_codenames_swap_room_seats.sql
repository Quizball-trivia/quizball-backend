SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';

-- The validated eight-seat ranges replace the six-seat checks and take their names (metadata only).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_room_seats_slot_v2' AND conrelid = 'public.room_seats'::regclass) THEN
    ALTER TABLE public.room_seats DROP CONSTRAINT IF EXISTS chk_room_seats_slot;
    ALTER TABLE public.room_seats RENAME CONSTRAINT chk_room_seats_slot_v2 TO chk_room_seats_slot;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_room_seats_seat_v2' AND conrelid = 'public.room_seats'::regclass) THEN
    ALTER TABLE public.room_seats DROP CONSTRAINT IF EXISTS chk_room_seats_seat;
    ALTER TABLE public.room_seats RENAME CONSTRAINT chk_room_seats_seat_v2 TO chk_room_seats_seat;
  END IF;
END $$;
