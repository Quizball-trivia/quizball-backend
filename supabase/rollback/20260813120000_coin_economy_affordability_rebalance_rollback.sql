-- Rollback for 20260813120000_coin_economy_affordability_rebalance.sql
-- Captured from PRODUCTION on 2026-08-13, before the rebalance.
--
-- Scoped to ONLY the 47 avatar products the forward migration reprices, and to
-- price_cents only. It deliberately does NOT touch currency, is_active, or any
-- unrelated product, so replaying it cannot clobber later catalogue edits.
--
-- Coin income constants (season-rp-formula.ts, daily-challenges.service.ts)
-- must be reverted in code separately; this file only covers store pricing
-- and the advertised daily-challenge rewards.

BEGIN;

UPDATE public.store_products SET price_cents = 15000 WHERE slug = 'avatar_facial_beard';
UPDATE public.store_products SET price_cents = 15000 WHERE slug = 'avatar_facial_handlebar';
UPDATE public.store_products SET price_cents = 10000 WHERE slug = 'avatar_facial_stache';
UPDATE public.store_products SET price_cents = 15000 WHERE slug = 'avatar_facial_stache_goatee';
UPDATE public.store_products SET price_cents = 20000 WHERE slug = 'avatar_glasses_aviator';
UPDATE public.store_products SET price_cents = 15000 WHERE slug = 'avatar_glasses_round';
UPDATE public.store_products SET price_cents = 10000 WHERE slug = 'avatar_glasses_wayfarer';
UPDATE public.store_products SET price_cents = 20000 WHERE slug = 'avatar_hair_buzz';
UPDATE public.store_products SET price_cents = 20000 WHERE slug = 'avatar_hair_cornrows';
UPDATE public.store_products SET price_cents = 20000 WHERE slug = 'avatar_hair_curly_crop';
UPDATE public.store_products SET price_cents = 5000 WHERE slug = 'avatar_hair_girl_basic';
UPDATE public.store_products SET price_cents = 10000 WHERE slug = 'avatar_hair_hamsik';
UPDATE public.store_products SET price_cents = 20000 WHERE slug = 'avatar_hair_leopard';
UPDATE public.store_products SET price_cents = 20000 WHERE slug = 'avatar_hair_ramos';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_hair_ronaldo_brazil';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_hair_ronaldo_goat';
UPDATE public.store_products SET price_cents = 20000 WHERE slug = 'avatar_hair_side_part';
UPDATE public.store_products SET price_cents = 20000 WHERE slug = 'avatar_hair_wave';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_ajax';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_argentina_retro';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_arsenal';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_atletico_madrid';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_barcelona';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_bayern';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_brazil_retro';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_dinamo_tbilisi';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_dortmund';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_england_away';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_england_home';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_france_retro';
UPDATE public.store_products SET price_cents = 50000 WHERE slug = 'avatar_jersey_georgia_retro';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_germany_retro';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_inter';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_italy_away';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_italy_home';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_italy_third';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_juve';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_liverpool';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_man_city';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_man_united';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_milan';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_napoli';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_netherlands_retro';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_newcastle';
UPDATE public.store_products SET price_cents = 50000 WHERE slug = 'avatar_jersey_psg_retro';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_real';
UPDATE public.store_products SET price_cents = 30000 WHERE slug = 'avatar_jersey_roma';

-- Advertised daily-challenge rewards (pre-migration values).
UPDATE public.daily_challenge_configs
SET coin_reward = CASE challenge_type
  WHEN 'moneyDrop' THEN 1000
  WHEN 'countdown' THEN 50
  WHEN 'careerPath' THEN 250
  WHEN 'highLow' THEN 100
  ELSE coin_reward
END
WHERE challenge_type IN ('moneyDrop', 'countdown', 'careerPath', 'highLow');

COMMIT;
