-- Migration-history reconciliation.
--
-- Production recorded this version when the additive OG-image-alt column was
-- pre-applied through Supabase. The canonical DDL lives in
-- 20260829112500_add_spanish_og_image_alt.sql. This no-op keeps the repository
-- and every environment's migration ledger aligned.

DO $$
BEGIN
  NULL;
END
$$;
