-- Grant 500 starter coins to new users + bump existing users by +500.
-- Stripe coin-pack purchases are temporarily disabled in the frontend, so
-- without this grant a brand-new account would land at 0 coins with no way
-- to buy avatar parts or ticket packs.

ALTER TABLE public.users
  ALTER COLUMN coins SET DEFAULT 500;

UPDATE public.users
  SET coins = coins + 500;
