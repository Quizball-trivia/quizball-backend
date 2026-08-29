-- Migration-history reconciliation.
--
-- Staging recorded this version when the additive Spanish schema was
-- pre-applied through Supabase. The canonical DDL lives in
-- 20260829093352_add_spanish_content_support.sql. This no-op keeps the
-- repository and every environment's migration ledger aligned.

DO $$
BEGIN
  NULL;
END
$$;
