SET LOCAL lock_timeout = '5s';

-- Validate after the ADD CONSTRAINT transaction has committed (SHARE UPDATE EXCLUSIVE: reads and writes on users go
-- on during the scan).
ALTER TABLE public.users VALIDATE CONSTRAINT chk_users_role_v2;
ALTER TABLE public.users VALIDATE CONSTRAINT chk_users_partner_slug;
