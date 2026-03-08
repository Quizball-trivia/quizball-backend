ALTER TABLE public.match_players
  DROP CONSTRAINT IF EXISTS match_players_seat_check;

ALTER TABLE public.match_players
  ADD CONSTRAINT match_players_seat_check
  CHECK (seat BETWEEN 1 AND 6);
