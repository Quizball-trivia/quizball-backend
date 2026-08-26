SET LOCAL lock_timeout = '5s';

-- Expand safely: NOT VALID avoids scanning the hot users table while the
-- ACCESS EXCLUSIVE lock for ADD CONSTRAINT is held. PostgreSQL still enforces
-- the check for every new or updated row immediately.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_country_iso2_check'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_country_iso2_check
      CHECK (country IS NULL OR country ~ '^[A-Z]{2}$')
      NOT VALID;
  END IF;
END
$$;
