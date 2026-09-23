-- Reviewer proposals are deliberately separate from immutable, playable content.
-- Only the admin backend can write them; publishing still goes through the
-- versioned Grid manifest and its evidence/alias validation.
ALTER TABLE public.football_grid_missing_answer_reports
  ADD COLUMN correction_proposal jsonb
    CHECK (correction_proposal IS NULL OR jsonb_typeof(correction_proposal) = 'object'),
  ADD COLUMN proposed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN proposed_at timestamptz,
  ADD CONSTRAINT football_grid_report_proposal_complete CHECK (
    (correction_proposal IS NULL AND proposed_at IS NULL)
    OR (correction_proposal IS NOT NULL AND proposed_at IS NOT NULL)
  );

COMMENT ON COLUMN public.football_grid_missing_answer_reports.correction_proposal IS
  'Admin-reviewed candidate only. Never read by the live answer resolver or treated as an accepted answer.';

CREATE INDEX football_grid_reports_review_queue_idx
  ON public.football_grid_missing_answer_reports (status, created_at DESC);
