-- OAuth providers can return an empty string for phone. Treat blank phone
-- values as absent so they do not collide with uq_users_phone_number_active.

UPDATE public.users
SET
  phone_number = NULL,
  phone_verified_at = NULL
WHERE phone_number IS NOT NULL
  AND length(btrim(phone_number)) = 0;

ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_phone_number_not_blank;

ALTER TABLE public.users
  ADD CONSTRAINT users_phone_number_not_blank
  CHECK (phone_number IS NULL OR length(btrim(phone_number)) > 0);
