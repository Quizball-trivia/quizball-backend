SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Staging preflight found no invalid rows. Production must pass the same scan;
-- failing here is safer than silently carrying fragmented country leaderboards.
ALTER TABLE public.users
  VALIDATE CONSTRAINT users_country_iso2_check;
