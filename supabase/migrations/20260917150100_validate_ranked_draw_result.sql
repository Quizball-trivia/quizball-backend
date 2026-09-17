-- migrate:no-transaction
-- Validate the result CHECKs added NOT VALID by 20260917150000. VALIDATE
-- CONSTRAINT scans under SHARE UPDATE EXCLUSIVE, so settlement writes keep
-- flowing; running it outside the DDL transaction keeps that lock short-lived
-- and separate from the forward migration's ACCESS EXCLUSIVE swap.
-- Idempotent: validating an already-valid constraint (staging, where the
-- original migration created it VALID) is a no-op.
ALTER TABLE public.ranked_rp_changes VALIDATE CONSTRAINT ranked_rp_changes_result_check;
ALTER TABLE public.wl_qp_awards VALIDATE CONSTRAINT wl_qp_awards_result_check;
