-- No backfill: a later visit cannot prove the platform of a historical first play.
ALTER TABLE public.guest_journeys ADD COLUMN first_play_platform text
  CHECK (first_play_platform IN ('web', 'android', 'ios', 'unknown'));
COMMENT ON COLUMN public.guest_journeys.first_play_platform IS
  'Immutable declared platform of the first recorded guest play. NULL legacy values are unknown. Not an authorization signal.';
