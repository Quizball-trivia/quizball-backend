-- Migration-history reconciliation.
--
-- Staging recorded this version when the Spanish catalogue translations were
-- pre-applied through Supabase. The canonical data migration lives in
-- 20260829191038_complete_spanish_catalog_translations.sql. This no-op keeps
-- the repository and the staging migration ledger aligned.

DO $$
BEGIN
  NULL;
END
$$;
