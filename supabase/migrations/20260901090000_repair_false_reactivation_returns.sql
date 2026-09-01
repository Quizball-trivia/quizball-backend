-- Restore dormant-reactivation enrollments that were incorrectly exited when
-- the baseline match timestamp lost sub-millisecond precision in application
-- code. A genuine return always has a non-dev match after enrollment.
UPDATE public.retention_journey_enrollments AS enrollment
SET
  status = 'active',
  exited_at = NULL,
  exit_reason = NULL
WHERE enrollment.journey_key = 'dormant_reactivation'
  AND enrollment.journey_version = 1
  AND enrollment.status = 'exited'
  AND enrollment.exit_reason = 'returned'
  AND NOT EXISTS (
    SELECT 1
    FROM public.match_players AS player
    JOIN public.matches AS match ON match.id = player.match_id
    WHERE player.user_id = enrollment.user_id
      AND match.is_dev = false
      AND match.started_at > enrollment.entered_at
  );
