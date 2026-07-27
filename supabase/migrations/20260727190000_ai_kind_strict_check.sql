-- Contract phase for ai_kind (expand phase: 20260727150000).
--
-- The writer deploy is verified on this environment: every AI-user creation
-- site passes ai_kind explicitly, and the backfill left zero NULL-kind AI
-- rows. Now the bridge trigger is dropped and the invariant becomes a table
-- constraint: is_ai and ai_kind must agree, so a future writer that forgets
-- the column fails loudly at insert instead of minting unclassified AI rows.
--
-- DEPLOY ORDERING: this migration must NOT ship in the same deploy as
-- 20260727150000 on any environment. Migrations run before the new app
-- starts; if both ran in one deploy window, the still-serving old app would
-- insert bare is_ai rows with no bridge trigger to classify them and fail
-- this CHECK. Staging: separate deploys already. Prod train: keep the two in
-- separate promotions.
--
-- Idempotent: safe under manual apply + deploy runner re-run.

DROP TRIGGER IF EXISTS trg_users_default_ai_kind ON public.users;
DROP FUNCTION IF EXISTS public.users_default_ai_kind();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_users_ai_kind_consistency'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT chk_users_ai_kind_consistency
      CHECK (is_ai = (ai_kind IS NOT NULL)) NOT VALID;
  END IF;
END;
$$;

ALTER TABLE public.users VALIDATE CONSTRAINT chk_users_ai_kind_consistency;
