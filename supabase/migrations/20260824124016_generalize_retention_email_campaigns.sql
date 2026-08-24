-- Generalize the server-owned retention email ledger so a campaign does not
-- need a Weekend League tournament. Existing Weekend League assignments keep
-- their current behavior; the new dormant-player campaign uses /play and has
-- no tournament dependency.

ALTER TABLE public.retention_email_assignments
  ALTER COLUMN tournament_id DROP NOT NULL,
  DROP CONSTRAINT retention_email_assignments_cta_state_check;

ALTER TABLE public.retention_email_assignments
  ADD COLUMN message_kind text NOT NULL DEFAULT 'weekend_league'
    CHECK (message_kind IN ('weekend_league', 'dormant_comeback')),
  ADD COLUMN lifetime_matches integer NOT NULL DEFAULT 0
    CHECK (lifetime_matches >= 0),
  ADD CONSTRAINT retention_email_assignments_cta_state_check
    CHECK (cta_state IN ('qualifying', 'qualified', 'comeback')),
  ADD CONSTRAINT uq_retention_email_assignment_campaign_user
    UNIQUE (campaign_key, user_id),
  ADD CONSTRAINT chk_retention_email_campaign_shape CHECK (
    (message_kind = 'weekend_league' AND tournament_id IS NOT NULL AND cta_state IN ('qualifying', 'qualified'))
    OR
    (message_kind = 'dormant_comeback' AND tournament_id IS NULL AND cta_state = 'comeback'
      AND destination_path = '/play' AND qp_remaining = 0)
  );

COMMENT ON COLUMN public.retention_email_assignments.message_kind IS
  'Selects the server-owned email template and eligibility revalidation path.';
COMMENT ON COLUMN public.retention_email_assignments.lifetime_matches IS
  'Aggregate non-dev match count captured at assignment time for cohort diagnostics.';

-- RLS and revoked browser grants were established by the original migration.
-- Reassert them so this migration remains safe if privileges drifted.
ALTER TABLE public.retention_email_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.retention_email_assignments FROM anon, authenticated;
