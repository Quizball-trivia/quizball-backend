-- Migration-history reconciliation.
--
-- Staging recorded this version when the Spanish campaign quiz seed was
-- pre-applied through Supabase. The canonical data migration lives in
-- 20260829191541_add_spanish_market_campaign_quizzes.sql. This no-op keeps the
-- repository and the staging migration ledger aligned.

DO $$
BEGIN
  NULL;
END
$$;
