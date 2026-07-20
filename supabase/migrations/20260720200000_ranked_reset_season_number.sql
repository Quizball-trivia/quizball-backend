-- Seasons are reset batches that represent a season's FINAL standings.
-- Boundary/utility batches (e.g. the June 11 "event starting" zeroing) keep
-- season_number NULL and never appear in the public seasons list.
ALTER TABLE ranked_reset_batches
  ADD COLUMN IF NOT EXISTS season_number integer;

CREATE UNIQUE INDEX IF NOT EXISTS ranked_reset_batches_season_number_key
  ON ranked_reset_batches (season_number)
  WHERE season_number IS NOT NULL;
