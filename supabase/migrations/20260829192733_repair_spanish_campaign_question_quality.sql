-- Migration-history reconciliation.
--
-- Staging recorded this version when the editorial repair was pre-applied
-- through Supabase. The canonical data migration lives in
-- 20260829192549_repair_spanish_campaign_question_quality.sql. This no-op
-- keeps the repository and the staging migration ledger aligned.

DO $$
BEGIN
  NULL;
END
$$;
