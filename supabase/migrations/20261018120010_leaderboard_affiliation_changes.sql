-- Country and club boards score players by their current country/club, so a switch moves every point a player has.
-- A switch between two different clubs (or countries) is allowed once per 30 days; these record the last one.
-- NULL = never switched (setting a club or country for the first time is not a switch).
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS club_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS country_changed_at timestamptz;
